-- Automatic tags use Cloudflare's Clef decision model. Move shipped defaults
-- (including the model id that never existed) and preserve custom models.
UPDATE ai_settings SET tag_model = '@cf/cloudflare/clef-flash'
WHERE tag_model IN ('@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/clef-flash-9b', '@cf/meta/llama-3.1-8b-instruct');
