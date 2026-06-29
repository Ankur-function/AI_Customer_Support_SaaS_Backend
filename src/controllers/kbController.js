import prisma from '../../db.js';
import pdfParse from 'pdf-parse-fork';
import { generateEmbedding } from '../services/aiService.js';

/**
 * 1. POST /api/v1/kb
 * Create a fresh help article (Restricted to Owners and Admins)
 */
export const createDocument = async (req, res) => {
    try {
        const { title, content, category, isPublished } = req.body;
        const { organizationId, id: userId } = req.user;

        if (!title || !content || !category) {
            return res.status(400).json({ message: "Title, content, and category fields are required." });
        }

        // ◄--- AI MODIFICATION: Generate Vector ---►
        console.log(`[AI Ingestion] Generating vector embeddings for article: "${title}"...`);
        const embeddingVector = await generateEmbedding(content);
        
        const vectorString = `[${embeddingVector.join(',')}]`;
        const newDocId = crypto.randomUUID();

        // Save using raw SQL to cleanly append the custom pgvector block
        await prisma.$queryRaw`
            INSERT INTO "Document" (
                "id", "organizationId", "title", "content", "category", "isPublished", "createdById", "embedding", "createdAt", "updatedAt"
            ) VALUES (
                ${newDocId}, ${organizationId}, ${title}, ${content}, ${category}, 
                ${isPublished !== undefined ? isPublished : true}, ${userId}, ${vectorString}::vector, NOW(), NOW()
            )
        `;
        // Fetch back using traditional prisma structure to return exact shape matching your existing app data response expectations
        const document = await prisma.document.findUnique({ where: { id: newDocId } });

        return res.status(201).json({ message: "Help article created successfully.", data: document });
    } catch (error) {
        console.error("Create Document Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/**
 * 2. GET /api/v1/kb
 * Fetch all articles for the logged-in user's organization
 */
export const getAllDocuments = async (req, res) => {
    try {
        const { organizationId } = req.user;
        const { category } = req.query;

        const filterConditions = { organizationId };
        if (category) filterConditions.category = category;

        const documents = await prisma.document.findMany({
            where: filterConditions,
            include: {
                createdBy: { select: { name: true, role: true } }
            },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({ message: "Knowledge base synced successfully.", count: documents.length, data: documents });
    } catch (error) {
        console.error("Get All Documents Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/**
 * 3. PUT /api/v1/kb/:id
 * Update an existing article with horizontal multi-tenant protection
 */
export const updateDocument = async (req, res) => {
    try {
        const { id: docId } = req.params;
        const { title, content, category, isPublished } = req.body;
        const { organizationId } = req.user;

        const document = await prisma.document.findUnique({ where: { id: docId } });
        if (!document || document.organizationId !== organizationId) {
            return res.status(404).json({ message: "Article context matching error inside this workspace." });
        }

        // ◄--- AI MODIFICATION: Re-Calculate Embeddings if text changes ---►
        const targetContent = content || document.content;  
        
        // Only run Gemini API call if content text explicitly changes to optimize performance/rate-limits
        if (content && content !== document.content) {
            console.log(`[AI Ingestion] Text modification detected. Re-indexing vector embeddings...`);
            const embeddingVector = await generateEmbedding(targetContent);
            const vectorString = `[${embeddingVector.join(',')}]`;
            
            // Execute physical embedding matrix shift separately to keep standard update fields linear
            await prisma.$queryRaw`
                UPDATE "Document" 
                SET "embedding" = ${vectorString}::vector 
                WHERE "id" = ${docId}
            `;
        }

        const updatedDoc = await prisma.document.update({
            where: { id: docId },
            data: {
                title: title || document.title,
                content: targetContent,
                category: category || document.category,
                isPublished: isPublished !== undefined ? isPublished : document.isPublished
            }
        });

        return res.status(200).json({ message: "Help article updated successfully.", data: updatedDoc });
    } catch (error) {
        console.error("Update Document Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/**
 * 4. DELETE /api/v1/kb/:id
 * Delete a document from the company's workspace repository
 */
export const deleteDocument = async (req, res) => {
    try {
        const { id: docId } = req.params;
        const { organizationId } = req.user;

        const document = await prisma.document.findUnique({ where: { id: docId } });
        if (!document || document.organizationId !== organizationId) {
            return res.status(404).json({ message: "Article context matching error inside this workspace." });
        }

        await prisma.document.delete({ where: { id: docId } });
        return res.status(200).json({ message: "Help article permanently removed from knowledge base repository." });
    } catch (error) {
        console.error("Delete Document Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/**
 * 5. POST /api/v1/kb/upload
 * Extracts text from an uploaded PDF file and saves it down as a Knowledge Base Document
 */
export const uploadPDFDocument = async (req, res) => {
    try {
        const { category } = req.body; // Category is passed alongside the file
        const { organizationId, id: userId } = req.user;

        // 1. Guard: Ensure a file was actually uploaded
        if (!req.file) {
            return res.status(400).json({ message: "No PDF document file detected in request payload." });
        }

        if (!category) {
            return res.status(400).json({ message: "Category field is required to index the file." });
        }

        // 2. Parse the binary PDF buffer into plain text strings
        let extractedData;
        try {
            extractedData = await pdfParse(req.file.buffer);
        } catch (pdfError) {
            console.error("PDF Parsing Library Error:", pdfError);
            return res.status(422).json({ message: "Failed to read binary PDF content stream. Ensure file is not corrupted." });
        }

        const rawContent = extractedData.text ? extractedData.text.trim() : "";
        
        if (!rawContent) {
            return res.status(400).json({ message: "Could not extract any clean text from this document. Is it empty or scan-only?" });
        }

        // 3. Clean up a dynamic Title using the original file name (strip extension)
        const formattedTitle = req.file.originalname
            .replace(/\.[^/.]+$/, "") // Removes extension (e.g., "refund_policy.pdf" -> "refund_policy")
            .replace(/[_-]/g, " ");   // Makes it human readable ("refund policy")

        // ◄--- AI MODIFICATION: PDF Vector Extraction ---►
        console.log(`[AI Ingestion] Extracted text from PDF. Fetching Gemini multi-dimensional vector array mapping...`);
        const embeddingVector = await generateEmbedding(rawContent);
        const vectorString = `[${embeddingVector.join(',')}]`;
        const newDocId = crypto.randomUUID();

        // Inject the text content alongside its respective geospatial float vector coordinates
        await prisma.$queryRaw`
            INSERT INTO "Document" (
                "id", "organizationId", "title", "content", "category", "isPublished", "createdById", "embedding", "createdAt", "updatedAt"
            ) VALUES (
                ${newDocId}, ${organizationId}, ${formattedTitle}, ${rawContent}, ${category}, 
                true, ${userId}, ${vectorString}::vector, NOW(), NOW()
            )
        `;

        const newDocument = await prisma.document.findUnique({ where: { id: newDocId } });
        
        return res.status(201).json({ 
            message: `Successfully ingested '${req.file.originalname}'. Text extracted and indexed.`, 
            data: newDocument 
        });

    } catch (error) {
        console.error("Upload PDF Document Error:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};