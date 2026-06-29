import 'dotenv/config'; // Ensures JWT_SECRET is loaded if this executes early
import jwt from 'jsonwebtoken';
import prisma from '../../db.js'; // 1. Import your Prisma client instance

 const userAuth = async (req, res, next) => {
    try {
        // 1. Extract token from cookies (fallback to Authorization header if needed for API flexibility)
        const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];

        if (!token) {
            return res.status(401).json({ message: 'Authentication required. Please log in.' });
        }

        // 2. Verify and decode the JWT token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // 3. Fail early if token structure doesn't include vital multi-tenant parameters
        if (!decoded.userId || !decoded.organizationId) {
            return res.status(403).json({ message: 'Malformed session token. Invalid context.' });
        }

        // 4. Verification check: Ensure the user and organization still exist in Postgres
        // Fetching only required fields to optimize database query performance
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                role: true,
                organizationId: true,
                // We also check if the organization is active/exists to prevent orphaning issues
                organization: {
                    select: {
                        id: true
                    }
                }
            }
        });

        if (!user || !user.organization) {
            return res.status(401).json({ message: 'User session invalid or organization no longer exists.' });
        }

        // 5. Context Injection: Attach identity and multi-tenant parameters to the request object
        req.user = {
            id: user.id,
            role: user.role,
            organizationId: user.organizationId // Every downstream route now automatically knows which company this is!
        };

        // 6. Hand over execution to the next controller/middleware line
        next();

    } catch (error) {
        console.error("Auth Middleware Error:", error.message);

        // Handle specific JWT error sub-types elegantly
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Session expired. Please log in again.' });
        }
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ message: 'Invalid token signature.' });
        }

        return res.status(500).json({ message: 'Internal Server Error during authentication.' });
    }
};

export default userAuth;