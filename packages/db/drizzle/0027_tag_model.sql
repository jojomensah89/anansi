-- Replace only shipped invalid/retired defaults; preserve custom models.
UPDATE ai_settings SET tag_model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
WHERE tag_model IN ('@cf/clef-flash-9b', '@cf/meta/llama-3.1-8b-instruct');
