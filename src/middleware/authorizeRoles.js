/**
 * Higher-Order Middleware to enforce Role-Based Access Control (RBAC)
 * @param {...string} allowedRoles - The roles permitted to access the route (e.g., 'owner', 'admin')
 */
export const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        try {
            // 1. Safety Check: Ensure user authentication middleware ran before this
            if (!req.user) {
                return res.status(500).json({ 
                    message: "Internal Configuration Error: authorizeRoles must be chained after userAuth middleware." 
                });
            }

            // 2. Authorization Check: Is the current user's role allowed?
            const hasPermission = allowedRoles.includes(req.user.role);

            if (!hasPermission) {
                return res.status(403).json({ 
                    message: `Access Denied: Your role (${req.user.role}) does not have the required permissions to perform this action.` 
                });
            }

            // 3. Authorized! Proceed to the next middleware or controller
            next();
            
        } catch (error) {
            console.error("RBAC Middleware Error:", error.message);
            return res.status(500).json({ message: "Internal Server Error during authorization checking." });
        }
    };
};