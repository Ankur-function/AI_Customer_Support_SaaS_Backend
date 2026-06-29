import crypto from 'crypto';
import prisma from '../../db.js';
import { emailQueue } from '../queues/emailQueue.js';
import bcrypt from 'bcrypt';

/**
 * to invite an agent or admin via email by owner or admin
 */
export const inviteMember = async (req, res) => {
    try {
        const { email, role } = req.body;
        // req.user.organizationId is automatically injected by your userAuth middleware
        const { organizationId,  role: requesterRole} = req.user; 

        if (!email) {
            return res.status(400).json({ message: 'Target member email is required.' });
        }

        // ◄--- CRITICAL SECURITY RULE: Prevents Admin Escalation Loops ---►
        const targetRole = role || 'agent'; // Fallback to agent if not provided

        if (targetRole === 'admin' && requesterRole !== 'owner') {
            return res.status(403).json({ 
                message: "Access Denied: Only the workspace owner can invite or provision administrative accounts." 
            });
        }
        
        if (targetRole === 'owner') {
            return res.status(403).json({ 
                message: "Access Denied: There can only be one workspace owner. Ownership cannot be duplicated." 
            });
        }

        // 1. Verify if the email is already an active user inside this organization
        const existingUser = await prisma.user.findUnique({
            where: { email }
        });

        if (existingUser) {
            return res.status(400).json({ 
                message: `User with this email is already a member of an organization.` 
            });
        }

        // 2. Generate a secure random token and set a 48-hour expiration date
        const inviteToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 48); // Token valid for 48 hours

        // 3. Upsert Invitation in PostgreSQL 
        // (Using upsert handles cases where an admin re-invites an expired or lost token)
        const invitation = await prisma.invitation.upsert({
            where: {
                email_organizationId: {
                    email,
                    organizationId
                }
            },
            update: {
                token: inviteToken,
                role: role || 'agent',
                expiresAt
            },
            create: {
                email,
                role: role || 'agent',
                token: inviteToken,
                organizationId,
                expiresAt
            },
            include: {
                organization: {
                    select: { name: true }
                }
            }
        });

        // 4. Construct the secure activation onboarding link
        const invitationLink = `${process.env.FRONTEND_URL}/accept-invite?token=${inviteToken}`;

        // 5. Offload email dispatch to BullMQ background worker
        await emailQueue.add('send-invite-email', {
            email: invitation.email,
            companyName: invitation.organization.name,
            invitationLink,
            expiresAt: invitation.expiresAt
        }, {
            attempts: 3, // Automatically retry 3 times if the email gateway fails
            backoff: 5000 // Wait 5 seconds between retries
        });

        // 6. Return response immediately
        return res.status(201).json({
            message: 'Invitation generated and dispatch queue initialized successfully.',
            data: {
                id: invitation.id,
                email: invitation.email,
                role: invitation.role,
                expiresAt: invitation.expiresAt,
                token:inviteToken
            }
        });

    } catch (error) {
        console.error("Invite Member Error:", error);
        return res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};

/**
 * when an agent or admin accepts invites
 */
export const acceptInvite = async (req, res) => {
    try {
        const { token, firstName, lastName, password } = req.body;

        if (!token || !firstName || !lastName || !password) {
            return res.status(400).json({ 
                message: 'Token, firstName, lastName, and password are required fields.' 
            });
        }

        const fullName = `${firstName} ${lastName}`.trim();

        // 1. Fetch the invitation details using the unique token
        const invitation = await prisma.invitation.findUnique({
            where: { token: token }
        });

        // 2. Security Check: Does the invite exist and is it still valid?
        if (!invitation) {
            return res.status(404).json({ message: 'Invalid or expired invitation token.' });
        }

        const isExpired = new Date() > invitation.expiresAt;
        if (isExpired) {
            // Clean up the expired token so it doesn't clutter the database
            await prisma.invitation.delete({ where: { id: invitation.id } });
            return res.status(410).json({ message: 'This invitation has expired. Please ask your administrator for a new link.' });
        }

        // 3. Hash the agent's chosen password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 4. Atomic Transaction: Create User and Clean up Invitation together
        const newAgent = await prisma.$transaction(async (tx) => {
            
            // Step A: Create the new team member user profile
            const user = await tx.user.create({
                data: {
                    name: fullName,
                    email: invitation.email, // Inherited from the invite
                    password: hashedPassword,
                    role: invitation.role,     // Inherited from the invite (e.g., agent/admin)
                    organizationId: invitation.organizationId // Hardcoded to the company workspace
                }
            });

            // Step B: Evict the invitation record from the cache table
            await tx.invitation.delete({
                where: { id: invitation.id }
            });

            return user;
        });

        // 5. Sanitize sensitive database fields before replying
        const { password: _, ...sanitizedUser } = newAgent;

        return res.status(201).json({
            message: 'Account onboarding finalized successfully. Welcome to your workspace!',
            data: sanitizedUser
        });

    } catch (error) {
        console.error("Accept Invite Error:", error);
        return res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};

/**
 * to get all members list including owner, agents and admins
 */
export const getMembers = async (req, res) => {
    try {
        // req.user.organizationId is automatically extracted from the JWT token by userAuth middleware
        const { organizationId } = req.user;

        // 1. Fetch all users belonging to this specific organization
        // We carefully select fields to avoid leaking sensitive data like password hashes
        const teamMembers = await prisma.user.findMany({
            where: {
                organizationId: organizationId
            },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                createdAt: true
            },
            orderBy: {
                createdAt: 'asc' // Shows the oldest members (usually owners/admins) first
            }
        });

        // 2. Return the array of isolated team members
        return res.status(200).json({
            message: "Team directory retrieved successfully.",
            count: teamMembers.length,
            data: teamMembers
        });

    } catch (error) {
        console.error("Get Members Error:", error);
        return res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};

/**
 * PATCH /api/v1/members/:id/role
 * Updates a team member's role within the organization boundaries
 */
export const updateMemberRole = async (req, res) => {
    try {
        const { id: targetUserId } = req.params; // The ID of the member being updated
        const { role: newRole } = req.body;
        const { organizationId, role: requesterRole, id: requesterId } = req.user;

        if (!newRole) {
            return res.status(400).json({ message: "New role field is required." });
        }

        // 1. Prevent self-modification
        if (targetUserId === requesterId) {
            return res.status(400).json({ message: "Operation rejected: You cannot modify your own role through this management endpoint." });
        }

        // 2. Fetch the target user to evaluate hierarchy bounds
        const targetUser = await prisma.user.findUnique({
            where: { id: targetUserId }
        });

        if (!targetUser) {
            return res.status(404).json({ message: "Team member not found." });
        }

        // 3. Multi-Tenant Guard: Check if target user belongs to the requester's company
        if (targetUser.organizationId !== organizationId) {
            return res.status(403).json({ message: "Access Denied: Target user belongs to a separate organization layer." });
        }

        // 4. Hierarchical RBAC Guards
        if (targetUser.role === 'owner') {
            return res.status(403).json({ message: "Access Denied: Root workspace ownership roles are immutable." });
        }

        if (newRole === 'owner') {
            return res.status(403).json({ message: "Access Denied: True ownership transfer requires a dedicated workflow." });
        }

        // An Admin trying to execute this route cannot touch another admin or promote an agent to admin
        if (requesterRole === 'admin') {
            if (targetUser.role === 'admin' || newRole === 'admin') {
                return res.status(403).json({ message: "Access Denied: Administrators cannot manage other administrative tier accounts." });
            }
        }

        // 5. Execute Update
        const updatedUser = await prisma.user.update({
            where: { id: targetUserId },
            data: { role: newRole },
            select: { id: true, name: true, email: true, role: true }
        });

        return res.status(200).json({
            message: "User role modified successfully.",
            data: updatedUser
        });

    } catch (error) {
        console.error("Update Member Role Error:", error);
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

/**
 * DELETE /api/v1/members/:id
 * Offboards and deletes a team member completely from the organization context
 */
export const deleteMember = async (req, res) => {
    try {
        const { id: targetUserId } = req.params;
        const { organizationId, role: requesterRole, id: requesterId } = req.user;

        // 1. Prevent self-deletion
        if (targetUserId === requesterId) {
            return res.status(400).json({ message: "Operation rejected: Self-offboarding is blocked via this endpoint." });
        }

        // 2. Fetch target user to check data boundaries
        const targetUser = await prisma.user.findUnique({
            where: { id: targetUserId }
        });

        if (!targetUser) {
            return res.status(404).json({ message: "Team member not found." });
        }

        // 3. Multi-Tenant Guard
        if (targetUser.organizationId !== organizationId) {
            return res.status(403).json({ message: "Access Denied: Target user profile belongs to an isolated tenant environment." });
        }

        // 4. Hierarchical RBAC Guards
        if (targetUser.role === 'owner') {
            return res.status(403).json({ message: "Access Denied: Root workspace owners cannot be expunged." });
        }

        if (requesterRole === 'admin' && targetUser.role === 'admin') {
            return res.status(403).json({ message: "Access Denied: Administrators do not possess rights to offboard co-administrators." });
        }

        // 5. Execute Deletion
        await prisma.user.delete({
            where: { id: targetUserId }
        });

        return res.status(200).json({
            message: `User account associated with ${targetUser.email} has been successfully offboarded and deleted.`
        });

    } catch (error) {
        console.error("Delete Member Error:", error);
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};