import { Router } from 'express';
import { 
    getAgentTickets, 
    getAgentTicketById, 
    assignTicket, 
    updateTicketStatus 
} from '../controllers/agentTicketController.js';
import userAuth  from '../middleware/userAuth.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';

const router = Router();

// Secure all access loops behind basic multi-tenant token verification
router.use(userAuth);
router.use(authorizeRoles('owner', 'admin', 'agent'));

// Dashboard and Timeline Query APIs
router.get('/', getAgentTickets);
router.get('/:id', getAgentTicketById);

// State Transition Modification APIs
router.patch('/:id/assign', assignTicket);
router.patch('/:id/status', updateTicketStatus);

export default router;