-- Hand-written immutable-manifest/projection guards; table DDL is generated in 0026.
CREATE TRIGGER acc_invoice_archive_validate BEFORE INSERT ON acc_invoice_archives BEGIN
  SELECT CASE WHEN
    NEW.invoice_count <> (
      SELECT count(DISTINCT json_extract(m.value, '$.invoiceId'))
      FROM json_each(NEW.manifest) m
    )
    OR NEW.expanded_bytes <> (
      SELECT sum(json_extract(m.value, '$.size')) FROM json_each(NEW.manifest) m
    )
    OR NEW.file_count <> (
      SELECT count(DISTINCT json_extract(m.value, '$.path')) FROM json_each(NEW.manifest) m
    )
    OR NEW.file_count <> (
      SELECT count(DISTINCT json_extract(m.value, '$.id')) FROM json_each(NEW.manifest) m
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.manifest) m
      WHERE json_type(m.value) IS NOT 'object'
        OR NOT EXISTS (
          SELECT 1 FROM acc_evidence e
          WHERE e.company_id = NEW.company_id
            AND e.id = json_extract(m.value, '$.evidenceId')
            AND e.id <> NEW.evidence_id
            AND e.hash = json_extract(m.value, '$.hash')
            AND e.size = json_extract(m.value, '$.size')
            AND e.size BETWEEN 1 AND 10485760
        )
        OR json_type(m.value, '$.compressionMethod') IS NOT 'integer'
        OR json_extract(m.value, '$.compressionMethod') NOT IN (0, 8)
        OR json_type(m.value, '$.compressedSize') IS NOT 'integer'
        OR json_extract(m.value, '$.compressedSize') NOT BETWEEN 0 AND 10485760
        OR json_type(m.value, '$.crc32') IS NOT 'integer'
        OR json_extract(m.value, '$.crc32') NOT BETWEEN 0 AND 4294967295
        OR json_type(m.value, '$.path') IS NOT 'text'
        OR length(json_extract(m.value, '$.path')) NOT BETWEEN 1 AND 512
    )
    THEN RAISE(ABORT, 'invalid_invoice_archive_manifest') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_archive_project AFTER INSERT ON acc_invoice_archives BEGIN
  INSERT INTO acc_invoice_archive_entries(company_id, id, archive_evidence_id, evidence_id, path, kind, invoice_id)
  SELECT NEW.company_id, json_extract(m.value, '$.id'), NEW.evidence_id,
    json_extract(m.value, '$.evidenceId'), json_extract(m.value, '$.path'),
    json_extract(m.value, '$.kind'), json_extract(m.value, '$.invoiceId')
  FROM json_each(NEW.manifest) m;
END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_archive_entry_insert BEFORE INSERT ON acc_invoice_archive_entries BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_invoice_archives a, json_each(a.manifest) m
    WHERE a.company_id = NEW.company_id AND a.evidence_id = NEW.archive_evidence_id
      AND json_extract(m.value, '$.id') = NEW.id
      AND json_extract(m.value, '$.evidenceId') = NEW.evidence_id
      AND json_extract(m.value, '$.path') = NEW.path
      AND json_extract(m.value, '$.kind') = NEW.kind
      AND json_extract(m.value, '$.invoiceId') IS NEW.invoice_id
  ) THEN RAISE(ABORT, 'invalid_invoice_archive_entry') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_archive_update BEFORE UPDATE ON acc_invoice_archives BEGIN
  SELECT RAISE(ABORT, 'immutable_invoice_archive');
END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_archive_delete BEFORE DELETE ON acc_invoice_archives BEGIN
  SELECT RAISE(ABORT, 'immutable_invoice_archive');
END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_archive_entry_update BEFORE UPDATE ON acc_invoice_archive_entries BEGIN
  SELECT RAISE(ABORT, 'immutable_invoice_archive_entry');
END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_archive_entry_delete BEFORE DELETE ON acc_invoice_archive_entries BEGIN
  SELECT RAISE(ABORT, 'immutable_invoice_archive_entry');
END;
