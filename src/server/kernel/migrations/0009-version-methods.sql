ALTER TABLE versions ADD COLUMN methods text NOT NULL DEFAULT '[]'
 CHECK (octet_length(methods) <= 64 AND methods::jsonb IN ('[]', '["human"]', '["auto"]', '["agent"]',
 '["human","auto"]', '["human","agent"]', '["auto","human"]', '["auto","agent"]',
 '["agent","human"]', '["agent","auto"]', '["human","auto","agent"]',
 '["human","agent","auto"]', '["auto","human","agent"]', '["auto","agent","human"]',
 '["agent","human","auto"]', '["agent","auto","human"]'));
UPDATE versions v SET methods = (
 SELECT coalesce(jsonb_agg(method ORDER BY ord), '[]'::jsonb)::text
 FROM unnest(ARRAY['human','auto','agent']) WITH ORDINALITY AS allowed(method, ord)
 WHERE jsonb_typeof((CASE WHEN pg_input_is_valid(v.body, 'jsonb') THEN v.body::jsonb ELSE '{}'::jsonb END)->'methods') = 'array'
 AND (CASE WHEN pg_input_is_valid(v.body, 'jsonb') THEN v.body::jsonb ELSE '{}'::jsonb END)->'methods' ? method
);
