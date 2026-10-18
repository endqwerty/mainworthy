-- Rebuild derived documents from current bodies, expanding pins at their recorded versions.
DELETE FROM search_docs;
INSERT INTO search_docs (rowid, title, body, tags, project)
SELECT c.id, json_extract(v.body, '$.title'),
	(
		SELECT group_concat(text, char(10)) FROM (
			SELECT json_extract(v.body, '$.pre') AS text, -1 AS position, 0 AS occurrence
			UNION ALL
			SELECT json_extract(part.value, '$.action') ||
				CASE WHEN coalesce(json_extract(part.value, '$.expected'), '') = '' THEN ''
				ELSE char(10) || json_extract(part.value, '$.expected') END,
				CAST(step.key AS INTEGER), CAST(part.key AS INTEGER)
			FROM json_each(v.body, '$.steps') step,
				json_each(CASE WHEN json_extract(step.value, '$.use') IS NULL THEN json_array(json(step.value))
				ELSE (
					SELECT json_extract(pinned.body, '$.steps')
					FROM cases fragment JOIN versions pinned ON pinned.case_id = fragment.id
					WHERE fragment.project = c.project
						AND fragment.no = CAST(substr(json_extract(step.value, '$.use.fragment'), 3) AS INTEGER)
						AND pinned.no = json_extract(step.value, '$.use.version')
				) END) part
			ORDER BY position, occurrence
		)
	),
	coalesce((SELECT group_concat(value, ' ') FROM json_each(c.tags)), ''), c.project
FROM cases c JOIN versions v ON v.case_id = c.id AND v.no = c.head;
