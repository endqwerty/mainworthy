ALTER TABLE actors ADD COLUMN auth_version bigint NOT NULL DEFAULT 0;
CREATE TABLE batch_admissions (
 batch bigint PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 actor bigint NOT NULL REFERENCES actors(id) DEFERRABLE INITIALLY IMMEDIATE,
 auth_version bigint NOT NULL,
 reference text NOT NULL
);
ALTER TABLE batches ADD CONSTRAINT batches_state_v2 CHECK (state IN ('accepted', 'processed', 'cancelled'));
ALTER TABLE batches DROP CONSTRAINT batches_state_check;

CREATE FUNCTION authority_actor_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.org, NEW.kind, NEW.name, NEW.disabled_at) IS DISTINCT FROM (OLD.org, OLD.kind, OLD.name, OLD.disabled_at) THEN
  NEW.auth_version := OLD.auth_version + 1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER authority_actor BEFORE UPDATE ON actors FOR EACH ROW EXECUTE FUNCTION authority_actor_changed();

CREATE FUNCTION authority_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected bigint[]; row_actor bigint;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF TG_TABLE_NAME = 'sessions' THEN
   IF OLD.ended_at IS NOT NULL THEN RETURN OLD; END IF;
  ELSIF TG_TABLE_NAME IN ('tokens', 'credentials') THEN
   IF OLD.revoked_at IS NOT NULL THEN RETURN OLD; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'team_grants' THEN
  SELECT array_agg(actor ORDER BY actor) INTO affected FROM team_members WHERE team IN (NEW.team, OLD.team);
 ELSIF TG_TABLE_NAME = 'orgs' THEN
  SELECT array_agg(id ORDER BY id) INTO affected FROM actors WHERE org IN (NEW.id, OLD.id);
 ELSE
  affected := ARRAY[NEW.actor, OLD.actor];
 END IF;
 FOR row_actor IN SELECT DISTINCT value FROM unnest(affected) AS changed(value) WHERE value IS NOT NULL ORDER BY value LOOP
  PERFORM id FROM actors WHERE id = row_actor FOR UPDATE;
  UPDATE actors SET auth_version = auth_version + 1 WHERE id = row_actor;
 END LOOP;
 IF TG_TABLE_NAME = 'team_grants' THEN
  PERFORM id FROM teams WHERE id IN (NEW.team, OLD.team) ORDER BY id FOR NO KEY UPDATE;
  IF EXISTS (SELECT FROM team_members WHERE team IN (NEW.team, OLD.team) AND NOT (actor = ANY(coalesce(affected, ARRAY[]::bigint[])))) THEN
   RAISE EXCEPTION 'team membership changed during authority lock discovery' USING ERRCODE = '40001';
  END IF;
 ELSIF TG_TABLE_NAME = 'team_members' THEN
  PERFORM id FROM teams WHERE id IN (NEW.team, OLD.team) ORDER BY id FOR NO KEY UPDATE;
 END IF;
 RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER authority_grant BEFORE INSERT OR UPDATE OR DELETE ON grants FOR EACH ROW EXECUTE FUNCTION authority_changed();
CREATE TRIGGER authority_team_grant BEFORE INSERT OR UPDATE OR DELETE ON team_grants FOR EACH ROW EXECUTE FUNCTION authority_changed();
CREATE TRIGGER authority_membership BEFORE INSERT OR UPDATE OR DELETE ON team_members FOR EACH ROW EXECUTE FUNCTION authority_changed();
CREATE TRIGGER authority_org BEFORE UPDATE ON orgs FOR EACH ROW EXECUTE FUNCTION authority_changed();
CREATE TRIGGER authority_token BEFORE INSERT OR UPDATE OF actor, revoked_at, expires_at, hash OR DELETE ON tokens FOR EACH ROW EXECUTE FUNCTION authority_changed();
CREATE TRIGGER authority_session BEFORE UPDATE OF actor, ended_at OR DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION authority_changed();
CREATE TRIGGER authority_credential BEFORE INSERT OR UPDATE OF actor, revoked_at, data OR DELETE ON credentials FOR EACH ROW EXECUTE FUNCTION authority_changed();
