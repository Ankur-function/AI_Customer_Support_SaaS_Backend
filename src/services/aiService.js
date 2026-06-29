import { GoogleGenAI } from '@google/genai';
import prisma from '../../db.js';

// Instantiates the official client. It automatically picks up the GEMINI_API_KEY environment variable.
// const ai = new GoogleGenAI();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); 

/**
 * Converts text strings (like parsed PDF pages or knowledge base articles)
 * into a 768-dimensional float mathematical coordinate array.
 * * @param {string} text - The content text string to embed.
 * @returns {Promise<number[]>} Array of 768 floating-point numbers.
 */
export const generateEmbedding = async (text) => {
  try {
    if (!text || typeof text !== 'string') {
      throw new Error("Invalid text input provided for vector embedding generation.");
    }

    // Call Google's dense vector embedding model
    const response = await ai.models.embedContent({
      model: 'gemini-embedding-001', // High-accuracy model
      contents: text,
      // Explicitly clamp dimensions to 768 to align with our Prisma schema constraint
      config: { outputDimensionality: 768 }
    });

    // ◄--- FIX HERE: Extract from the first element of the embeddings array ---►
    if (!response.embeddings || response.embeddings.length === 0 || !response.embeddings[0].values) {
      throw new Error("Failed to extract valid matrix values from Gemini API response.");
    }

    return response.embeddings[0].values;
  } catch (error) {
    console.error("Error in aiService [generateEmbedding]:", error.message);
    throw error;
  }
};

/**
 * Generates a targeted support answer grounded strictly within provided context documentation snippets.
 * Prevents hallucinations by instructing the LLM to admit ignorance if text matches are missing.
 * * @param {string} question - The live customer chat query.
 * @param {string[]} contextChunks - Array of text snippets pulled from our pgvector SQL match.
 * @returns {Promise<string>} Streamable or text response from the LLM.
 */
export const generateGroundedResponse = async (question, contextChunks) => {
  try {
    const combinedContext = contextChunks.join("\n\n---\n\n");

    const systemInstruction = `
      You are an expert, empathetic AI Customer Support Agent representing a business workspace.
      Your goal is to answer the user's question using ONLY the verified context blocks provided below.

      CRITICAL CONSTRAINTS:
      1. Rely strictly on the provided context text. Do not make up facts or extrapolate.
      2. If the context text does not contain enough information to accurately answer the question, reply exactly with:
         "I'm sorry, I don't have enough information in my knowledge base to answer that request. Let me redirect you to a human agent."
      3. Keep your response professional, clear, and direct.

      CONTEXT SNIPPETS FROM KNOWLEDGE BASE:
      ${combinedContext}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // Fastest and highly accurate free-tier model
      contents: question,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.2 // Low temperature ensures factual grounding over creativity
      }
    });

    return response.text;
  } catch (error) {
    console.error("Error in aiService [generateGroundedResponse]:", error.message);
    throw error;
  }
};

/**
 * Searches the PostgreSQL Document table using Cosine Distance vector math
 * to find the top 2 most relevant context snippets matching a query.
 * * @param {string} organizationId - Scope the search to the customer's company workspace.
 * @param {number[]} queryVector - The 768-dimension array generated from the customer's question.
 * @returns {Promise<string[]>} Array of matching text contents.
 */
export const searchKnowledgeBase = async (organizationId, queryVector) => {
  try {
    const vectorString = `[${queryVector.join(',')}]`;

    // Cosine Distance operator (<=>) calculates spatial separation.
    // Smaller distance = higher semantic similarity.
    const matches = await prisma.$queryRaw`
      SELECT "content"
      FROM "Document"
      WHERE "organizationId" = ${organizationId} 
        AND "isPublished" = true
        AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${vectorString}::vector
      LIMIT 2
    `;

    // Map rows out into a clean flat array of text strings
    return matches.map(match => match.content);
  } catch (error) {
    console.error("Error in aiService [searchKnowledgeBase]:", error.message);
    return [];
  }
};