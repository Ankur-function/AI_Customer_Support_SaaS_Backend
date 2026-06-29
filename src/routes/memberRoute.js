import { Router } from 'express';
import { acceptInvite, deleteMember, getMembers, inviteMember, updateMemberRole } from '../controllers/memberController.js';
import  userAuth  from '../middleware/userAuth.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';

const router = Router();

// Secure workflow pipeline: Check session -> Validate RBAC rights -> Run Controller
router.post('/invite', userAuth, authorizeRoles('owner', 'admin'), inviteMember);

// Public route - Token acts as the cryptographic credential
router.post('/accept-invite', acceptInvite);

// Secured multi-tenant team list endpoint
router.get('/', userAuth, authorizeRoles('owner', 'admin', 'agent'), getMembers);

// Modify member role
router.patch('/:id/role', userAuth, authorizeRoles('owner', 'admin'), updateMemberRole);

// Offboard/Delete member
router.delete('/:id', userAuth, authorizeRoles('owner', 'admin'), deleteMember);

// Only the root Owner can do things like delete the company workspace
router.delete('/workspace', userAuth, authorizeRoles('owner'), (req, res) => {
    res.json({ message: "Workspace deleted successfully" });
});

export default router;