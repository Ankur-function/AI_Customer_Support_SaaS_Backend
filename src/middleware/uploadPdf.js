import multer from 'multer';

// 1. Configure the Multer engine to store files as temporary buffers in system memory
const storage = multer.memoryStorage();

// 2. Define strict corporate payload guard rails
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Enforce strict 5MB upload ceiling cap
    fileFilter: (req, file, cb) => {
        // Enforce strict PDF mime-type verification
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file structure type. Only PDF documents are accepted.'), false);
        }
    }
});

// 3. Create the standard execution middleware hook targeting a single file field named 'docFile'
const pdfUploadMiddleware = upload.single('docFile');

// 4. Clean Express wrapper middleware to trap binary stream exceptions gracefully
export const handlePdfUpload = (req, res, next) => {
    pdfUploadMiddleware(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            // Target specific Multer limitations (e.g., File too large)
            return res.status(400).json({ message: `File upload limit exceeded: ${err.message}` });
        } else if (err) {
            // Target our custom MIME-type validation failures
            return res.status(400).json({ message: err.message });
        }
        // If everything is completely fine, advance to the controller
        next();
    });
};