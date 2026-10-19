-- Old merge paths are unambiguous except steps.order. Order conflicts carry three arrays of ids;
-- conflicts about the step named order carry step objects or omit a deleted side.
CREATE TEMP TABLE conflict_address_upgrade AS
SELECT proposal_id, edit_index, conflict_index,
	CASE
		WHEN path = 'steps.order'
			AND json_type(conflict, '$.base') = 'array'
			AND json_type(conflict, '$.mine') = 'array'
			AND json_type(conflict, '$.theirs') = 'array'
			THEN json_object('kind', 'step-order')
		WHEN substr(path, 1, 7) = 'fields.'
			THEN json_object('kind', 'custom-field', 'key', substr(path, 8))
		WHEN substr(path, 1, 6) = 'steps.' AND instr(substr(path, 7), '.') = 0
			THEN json_object('kind', 'step', 'id', substr(path, 7))
		WHEN substr(path, 1, 6) = 'steps.'
			THEN json_object('kind', 'step-field',
				'id', substr(path, 7, instr(substr(path, 7), '.') - 1),
				'name', substr(path, 7 + instr(substr(path, 7), '.')))
		ELSE json_object('kind', 'field', 'name', path)
	END AS address
FROM (
	SELECT proposal.id AS proposal_id, edit.key AS edit_index, item.key AS conflict_index,
		item.value AS conflict, json_extract(item.value, '$.path') AS path
	FROM proposals proposal, json_each(proposal.resolved) edit, json_each(edit.value, '$.conflicts') item
	WHERE json_extract(edit.value, '$.op') = 'edit' AND json_type(item.value, '$.path') = 'text'
);

CREATE UNIQUE INDEX conflict_address_upgrade_key ON conflict_address_upgrade (proposal_id, edit_index, conflict_index);

UPDATE proposals
SET resolved = (
	SELECT json_group_array(json(
		CASE WHEN json_extract(edit.value, '$.op') = 'edit' THEN
			json_set(edit.value, '$.conflicts', json((
				SELECT json_group_array(json(
					CASE WHEN legacy.address IS NULL THEN item.value ELSE
						json_set(json_remove(item.value, '$.path'), '$.address', json(legacy.address))
					END
				) ORDER BY item.key)
				FROM json_each(edit.value, '$.conflicts') item
				LEFT JOIN conflict_address_upgrade legacy
					ON legacy.proposal_id = proposals.id AND legacy.edit_index = edit.key AND legacy.conflict_index = item.key
			)))
		ELSE edit.value END
	) ORDER BY edit.key)
	FROM json_each(proposals.resolved) edit
)
WHERE id IN (SELECT proposal_id FROM conflict_address_upgrade);

-- Receipts kept paths without values. Recover their addresses from the corresponding proposal's
-- conflict groups, in seal order, preserving duplicate steps.order entries and repeated case edits.
CREATE TEMP TABLE proposal_conflict_addresses_upgrade AS
SELECT proposal.project, 'P-' || proposal.no AS proposal_ref,
	row_number() OVER (PARTITION BY proposal.id ORDER BY edit.key) - 1 AS conflict_index,
	(
		SELECT json_group_array(json_extract(item.value, '$.address') ORDER BY item.key)
		FROM json_each(edit.value, '$.conflicts') item
	) AS addresses
FROM proposals proposal, json_each(proposal.resolved) edit
WHERE json_extract(edit.value, '$.op') = 'edit' AND json_array_length(edit.value, '$.conflicts') > 0;

CREATE UNIQUE INDEX proposal_conflict_addresses_upgrade_key
	ON proposal_conflict_addresses_upgrade (project, proposal_ref, conflict_index);

UPDATE commands
SET outcome = json_set(outcome, '$.conflicts', json((
	SELECT json_group_array(json(
		CASE WHEN json_type(item.value, '$.paths') = 'array' THEN
			json_set(json_remove(item.value, '$.paths'), '$.addresses', json(saved.addresses))
		ELSE item.value END
	) ORDER BY item.key)
	FROM json_each(commands.outcome, '$.conflicts') item
	LEFT JOIN proposal_conflict_addresses_upgrade saved
		ON saved.project = commands.project AND saved.proposal_ref = json_extract(commands.outcome, '$.proposal')
			AND saved.conflict_index = item.key
)))
WHERE op = 'propose' AND EXISTS (
	SELECT 1 FROM json_each(CASE WHEN json_valid(outcome) THEN outcome ELSE '{}' END, '$.conflicts') item
	WHERE json_type(item.value, '$.paths') = 'array'
);

DROP TABLE proposal_conflict_addresses_upgrade;
DROP TABLE conflict_address_upgrade;
