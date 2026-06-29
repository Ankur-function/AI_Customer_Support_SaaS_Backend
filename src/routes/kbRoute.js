import { Router } from 'express';
import { 
    createDocument, 
    getAllDocuments, 
    updateDocument, 
    deleteDocument, 
    uploadPDFDocument
} from '../controllers/kbController.js';
import  userAuth  from '../middleware/userAuth.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';
import { handlePdfUpload } from '../middleware/uploadPdf.js';

const router = Router();

// Lock down all endpoints behind multi-tenant user authentication
router.use(userAuth);

// Read Access: Agents, Admins, and Owners can read articles
router.get('/', authorizeRoles('owner', 'admin', 'agent'), getAllDocuments);

// Write/Modify Access: Only Managers (Admins) and Executives (Owners) can build or destroy knowledge docs
router.post('/create', authorizeRoles('owner', 'admin'), createDocument);
router.put('/update/:id', authorizeRoles('owner', 'admin'), updateDocument);
router.delete('/:id', authorizeRoles('owner', 'admin'), deleteDocument);

// --- Document Ingestion Pipeline Interface ---
router.post('/upload', authorizeRoles('owner', 'admin'), handlePdfUpload, uploadPDFDocument);

export default router;