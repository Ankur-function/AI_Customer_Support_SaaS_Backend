-- 1. Activate the structural vector data-type and spatial matching functions
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. (Optional but Senior Best-Practice) Verify active extension footprint
-- This ensures the runtime log traces show vector primitives are active.