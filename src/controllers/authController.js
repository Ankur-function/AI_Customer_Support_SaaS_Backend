import 'dotenv/config';
import jwt from 'jsonwebtoken'
// import User from '../models/userModel.js'
import bcrypt from 'bcrypt'
import prisma from '../../db.js';
// import {validation} from '../utils/validation.js'

export const signUp = async (req, res) => {
    try {
        const body = req.body;

        // Destructure companyName along with user fields
        const { firstName, lastName, email, password, role, companyName } = body;
        
        if (!companyName) {
            return res.status(400).json({ message: 'Company Name is required to initialize an organization.' });
        }

        const fullName = `${firstName} ${lastName}`.trim();

        // 1. Check if user already exists
        const isUserExist = await prisma.user.findUnique({
            where: { email: email }
        });
        
        if (isUserExist) {
            return res.status(400).json({ message: 'User Already Exists!' });
        }

        // 2. Hash the password
        const hashPassword = await bcrypt.hash(password, 10);

        // 3. Generate a URL-friendly slug from company name (e.g., "Swiggy Tech" -> "swiggy-tech")
        const slug = companyName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric characters with hyphens
            .replace(/(^-|-$)+/g, '');   // Trim leading/trailing hyphens

        // 4. Atomic Transaction: Create Organization and User together i.e.
        //  If the user creation succeeds but the organization creation fails, your database will enter an inconsistent state. Using a transaction ensures either both succeed or both roll back.
        const result = await prisma.$transaction(async (tx) => {
            // First, create the Organization
            const organization = await tx.organization.create({
                data: {
                    name: companyName,
                    slug: slug
                }
            });

            // Second, create the User linked to this organization
            // The person signing up defaults to 'owner' if not specifically overridden
            const userCreated = await tx.user.create({
                data: {
                    name: fullName,
                    email,
                    password: hashPassword,
                    role: 'owner', 
                    organizationId: organization.id // Link via Foreign Key
                }
            });

            return { user: userCreated, organization };
        });

        // 5. Generate JWT including both userId and organizationId
        const token = jwt.sign(
            { 
                userId: result.user.id, 
                organizationId: result.organization.id,
                role: result.user.role 
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        // 6. Send the cookie securely
        res.cookie("token", token, {
            httpOnly: true,  // Protects against XSS attacks
            secure: true,    // REQUIRED for cross-domain HTTPS
            sameSite: "none", // REQUIRED for cross-domain cookies
        });

        // 7. Sanitize output (Do not send password back to client)
        const { password: _, ...sanitizedUser } = result.user;

        res.status(201).json({
            message: 'Organization and User created Successfully',
            data: {
                user: sanitizedUser,
                organization: result.organization
            }
        });
        
    } catch (error) {
        console.error(error);
        
        // Handle Prisma unique constraint violations (P2002) specifically for the slug field
        if (error.code === 'P2002') {
            return res.status(400).json({ message: 'This company name/slug is already taken.' });
        }

        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};

export const signIn = async (req, res) => {
    try { 
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        // 1. Find user by email (Prisma fetches the organizationId field natively)
        const user = await prisma.user.findUnique({
            where: { email: email }
        });
        
        // Security best practice: Use the exact same generic error message for email or password mismatches 
        // to prevent bad actors from guessing valid email addresses.
        if (!user) {
            return res.status(401).json({ message: 'Invalid Credentials' });
        }

        // 2. Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ message: 'Invalid Credentials' });
        }

        // 3. Generate JWT including both identity (userId) and multi-tenant context (organizationId)
        const token = jwt.sign(
            { 
                userId: user.id, 
                organizationId: user.organizationId, // Crucial for isolating AI knowledge base data later
                role: user.role 
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        // 4. Send the cookie securely to the browser
        res.cookie("token", token, { 
            httpOnly: true,  // Protects against XSS attacks
            secure: true,    // REQUIRED for cross-domain HTTPS
            sameSite: "none", // REQUIRED for cross-domain cookies
        });
        
        // 5. Sanitize output (Remove sensitive fields before sending user data back)
        const { password: _, ...sanitizedUser } = user;

        return res.status(200).json({
            message: 'Login successful',
            data: sanitizedUser
        });
        
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};

export const signOut = async(req,res)=> {
    try {
       res.clearCookie("token");
        res.status(200).send('Logout Successful')
    } catch (error) {
        res.status(500).send('Error during log out')
    }
}