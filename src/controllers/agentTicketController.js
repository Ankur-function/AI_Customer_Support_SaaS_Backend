import prisma from '../../db.js';

/**
 * 1. GET /api/v1/agent/tickets
 * The Live Queue Dashboard - Fetches company isolated tickets with optional filtering
 * to fetch all tickets corrospoinding to their organisation
 */
export const getAgentTickets = async (req, res) => {
    try {
        const { organizationId } = req.user;
        const { status, priority } = req.query; // Capture query params like ?status=OPEN

        // Build a dynamic filter object bound to the tenant layer
        const filterConditions = { organizationId };

        if (status) filterConditions.status = status.toUpperCase();
        if (priority) filterConditions.priority = priority.toUpperCase();

        const tickets = await prisma.ticket.findMany({
            where: filterConditions,
            include: {
                customer: {
                    select: { name: true, email: true }
                },
                assignedTo: {
                    select: { id: true, name: true, role: true }
                }
            },
            orderBy: { updatedAt: 'desc' } // Bring recently active threads to top
        });

        return res.status(200).json({
            message: "Workspace dashboard ticket queue synced successfully.",
            count: tickets.length,
            data: tickets
        });
    } catch (error) {
        console.error("Get Agent Tickets Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/**
 * 2. GET /api/v1/agent/tickets/:id
 * The Deep-Dive Workspace View - Loads a single thread timeline for conversation processing
 * fetches a single ticket details from agent point of view
 */
export const getAgentTicketById = async (req, res) => {
    try {
        const { id: ticketId } = req.params;
        const { organizationId } = req.user;

        const ticket = await prisma.ticket.findUnique({
            where: { id: ticketId },
            include: {
                customer: true,
                assignedTo: { select: { id: true, name: true, email: true, role: true } },
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });

        if (!ticket) {
            return res.status(404).json({ message: "Ticket not found." });
        }

        // Multi-Tenant Guard Block
        if (ticket.organizationId !== organizationId) {
            return res.status(403).json({ message: "Access Denied: Horizontal cross-tenant data leak prevented." });
        }

        return res.status(200).json({ message: "Ticket details retrieved successfully.", data: ticket });
    } catch (error) {
        console.error("Get Agent Ticket By ID Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/**
 * 3. PATCH /api/v1/agent/tickets/:id/assign
 * Claim / Route a Ticket to an internal account profile
 * to assign a ticket to any agent.
 */
export const assignTicket = async (req, res) => {
    try {
        const { id: ticketId } = req.params;
        const { userId } = req.body; 
        const { organizationId, id: requesterId, role: requesterRole } = req.user;

        // Determine who the ticket is being assigned to
        const targetUserId = userId || requesterId;
        const isSelfAssignment = targetUserId === requesterId;

        // 1. Verify the ticket exists and belongs to this organization
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket || ticket.organizationId !== organizationId) {
            return res.status(404).json({ message: "Ticket context matching error inside this workspace." });
        }

        // 2. Verify the target assignee profile exists in the exact same organization
        const targetAssignee = await prisma.user.findUnique({ where: { id: targetUserId } });
        if (!targetAssignee || targetAssignee.organizationId !== organizationId) {
            return res.status(400).json({ message: "Invalid target assignment user constraint." });
        }

        // ◄--- CRITICAL WORKFLOW HIERARCHY GUARDS ---►
        
        // Rule A: Prevent anyone from assigning tickets to the Owner (unless the Owner self-claims it)
        if (targetAssignee.role === 'owner' && !isSelfAssignment) {
            return res.status(403).json({ 
                message: "Access Denied: Support tickets cannot be directly assigned to the workspace owner." 
            });
        }

        // Rule B: If an AGENT is making the request, restrict their dispatch capabilities
        if (requesterRole === 'agent') {
            // An agent can self-claim, but if they are routing it to someone else, check that person's role
            if (!isSelfAssignment && targetAssignee.role === 'admin') {
                return res.status(403).json({ 
                    message: "Access Denied: Standard agents do not possess authority to assign tickets to administrators." 
                });
            }
        }

        // 3. Execute update transactionally
        const updatedTicket = await prisma.ticket.update({
            where: { id: ticketId },
            data: { 
                assignedUserId: targetUserId,
                status: 'IN_PROGRESS' 
            },
            include: { assignedTo: { select: { name: true, role: true } } }
        });

        return res.status(200).json({ 
            message: `Ticket successfully assigned to ${updatedTicket.assignedTo.name} (${updatedTicket.assignedTo.role}).`, 
            data: updatedTicket 
        });

    } catch (error) {
        console.error("Assign Ticket Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/**
 * 4. PATCH /api/v1/agent/tickets/:id/status
 * Explicit ticket workflow transition (OPEN -> IN_PROGRESS -> RESOLVED)
 * to update the ticket status
 */
export const updateTicketStatus = async (req, res) => {
    try {
        const { id: ticketId } = req.params;
        const { status } = req.body;
        const { organizationId, id: requesterId, role: requesterRole } = req.user;

        if (!status) {
            return res.status(400).json({ message: "Status parameter value required." });
        }

        const validStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];
        if (!validStatuses.includes(status.toUpperCase())) {
            return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        // 1. Fetch the ticket AND include the role of the person currently assigned to it
        const ticket = await prisma.ticket.findUnique({ 
            where: { id: ticketId },
            include: {
                assignedTo: {
                    select: { id: true, role: true }
                }
            }
        });

        // 2. Multi-Tenant Guard
        if (!ticket || ticket.organizationId !== organizationId) {
            return res.status(404).json({ message: "Ticket mapping error inside this corporate context." });
        }

        // ◄--- CRITICAL TICKET WORKFLOW OWNERSHIP GUARDS ---►
        
        // If the ticket is currently assigned to someone, evaluate hierarchical privileges
        if (ticket.assignedTo) {
            const assigneeId = ticket.assignedTo.id;
            const assigneeRole = ticket.assignedTo.role;
            const isSelfOwned = assigneeId === requesterId;

            // Rule A: If assigned to the Owner, NO ONE else can modify its state
            if (assigneeRole === 'owner' && requesterRole !== 'owner') {
                return res.status(403).json({ 
                    message: "Access Denied: This ticket is managed by the workspace owner and its state is locked." 
                });
            }

            // Rule B: If assigned to an Admin, regular agents are blocked from modifying it
            if (assigneeRole === 'admin' && requesterRole === 'agent') {
                return res.status(403).json({ 
                    message: "Access Denied: Standard agents cannot alter statuses of tickets assigned to administrators." 
                });
            }

            // Rule C: If assigned to an Agent, other peer agents cannot touch it (unless it's self-owned)
            if (assigneeRole === 'agent' && requesterRole === 'agent' && !isSelfOwned) {
                return res.status(403).json({ 
                    message: "Access Denied: You cannot modify the status of a ticket assigned to another agent." 
                });
            }
        }

        // 3. Execute Update
        const updatedTicket = await prisma.ticket.update({
            where: { id: ticketId },
            data: { status: status.toUpperCase() }
        });

        return res.status(200).json({ 
            message: `Ticket status successfully advanced to ${updatedTicket.status}`, 
            data: updatedTicket 
        });

    } catch (error) {
        console.error("Update Ticket Status Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};