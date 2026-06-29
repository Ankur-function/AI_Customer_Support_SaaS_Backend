import { Router } from 'express';
import { createCustomerTicket, getTicketHistory } from '../controllers/customerTicketController.js';

const router = Router();

// Public route for customer widget integration
router.post('/create', createCustomerTicket);
router.get('/:id', getTicketHistory); // ◄--- Add this line

export default router;