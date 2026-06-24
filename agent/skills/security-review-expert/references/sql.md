# T-SQL / SQL Server

SQL Server 2017+ and Azure SQL.

## Dynamic SQL

- `EXEC('… ' + @var)` concatenation. Use `sp_executesql` with parameters: `sp_executesql N'… WHERE id = @id', N'@id int', @id = @input`.
- For object names (table, column, schema), use `QUOTENAME(@name, ']')` and validate against `sys.objects` / `sys.columns` before interpolation. Note `sysname` truncates at 128 chars — values can pass validation after truncation but inject after reaching a longer buffer.

## Ownership chaining

- Cross-database calls where the owner differs break the chain — caller must hold explicit object permission.
- Sign procedures with a certificate, create a login from the certificate in the target database, grant only required permissions. `EXECUTE AS USER` (database scope) is acceptable; `EXECUTE AS LOGIN` elevates to server scope and is a privilege-escalation vector.

## Least-privilege role design

- Avoid `db_datareader` / `db_datawriter` for application logins — they cover every table including future ones.
- Prefer schema-level GRANT (`GRANT SELECT ON SCHEMA::app TO app_role`) so new objects inherit permissions only within the intended schema.
- Use application roles (`sp_setapprole`) for session-scoped elevation under connection pooling.

## Encryption

- TDE protects data at rest but not memory or backups copied off-server. Always pair with backup encryption.
- Always Encrypted: deterministic encryption enables equality predicates but leaks frequency information; randomized encryption blocks all server-side predicates.
- `ENCRYPTBYKEY`/`DECRYPTBYKEY` keys are visible in `sys.symmetric_keys` — does not protect against high-privilege DBA.

## Linked Server / EXECUTE AT injection

- `OPENQUERY(REMOTESVR, '… ' + @val + '…')` — string concatenation inside OpenQuery passes injected SQL to the remote server.
- Use `EXECUTE (@sql) AT linked_server` with `sp_executesql` on the remote side. Flag `OPENROWSET` / `OPENDATASOURCE` ad-hoc queries — they require `Ad Hoc Distributed Queries` enabled.

## SQL Agent jobs

- `CmdExec` steps run as the SQL Agent service account — user-controlled content in step text is OS command injection.
- Credentials hardcoded in step text appear in `msdb.dbo.sysjobsteps` in cleartext.
- Proxy accounts granted `sysadmin` defeat the proxy purpose.

## CLR assemblies

- `PERMISSION_SET = UNSAFE` allows arbitrary managed code including P/Invoke.
- `TRUSTWORTHY ON` plus `EXTERNAL_ACCESS` grants permissions without a certificate — any database owner can escalate to sysadmin-equivalent.
- Verify `is_trustworthy_on = 0` in `sys.databases` for all user databases. Strict security mode (2017+) requires assemblies to be signed.

## xp_cmdshell

- Enable status from `sys.configurations`. Disabling is necessary but not sufficient — `sysadmin` can re-enable in-session. Audit `sp_configure` changes via Server Audit `SERVER_OBJECT_CHANGE_GROUP`.

## Audit configuration

- Server Audit storing logs on the same volume as data files = single point of tampering. Target a remote share or Azure Blob.
- `ON_FAILURE = CONTINUE` lets the server keep running with audit unavailable. High-assurance workloads should use `SHUTDOWN`.
- Database audit specs minimum: `SCHEMA_OBJECT_ACCESS_GROUP`, `DATABASE_ROLE_MEMBER_CHANGE_GROUP`, `DATABASE_PERMISSION_CHANGE_GROUP`, `FAILED_DATABASE_AUTHENTICATION_GROUP`.

## RLS / DDM

- RLS predicate functions without `SCHEMABINDING` allow silent table modifications.
- DDM bypassed by `UNMASK` permission (2019+) or aggregate inference; not preserved through linked-server queries depending on configuration.

## Backup encryption

- `BACKUP DATABASE … TO DISK = '…'` without `WITH ENCRYPTION` produces an unencrypted full data copy that bypasses TDE/RLS/DDM.
- Use `WITH ENCRYPTION (ALGORITHM = AES_256, SERVER CERTIFICATE = …)`. Back up the certificate and its private key separately — loss makes backups irrecoverable.

## First-party entry points (T-SQL)

- SQL injection guidance: `learn.microsoft.com/sql/relational-databases/security/sql-injection`
- sp_executesql: `learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-executesql-transact-sql`
- Ownership chains: `learn.microsoft.com/sql/relational-databases/security/ownership-chains`
- EXECUTE AS clause: `learn.microsoft.com/sql/t-sql/statements/execute-as-clause-transact-sql`
- Row-Level Security: `learn.microsoft.com/sql/relational-databases/security/row-level-security`
- Dynamic Data Masking: `learn.microsoft.com/sql/relational-databases/security/dynamic-data-masking`
- Always Encrypted: `learn.microsoft.com/sql/relational-databases/security/encryption/always-encrypted-database-engine`
- TDE: `learn.microsoft.com/sql/relational-databases/security/encryption/transparent-data-encryption`
- SQL Server Audit: `learn.microsoft.com/sql/relational-databases/security/auditing/sql-server-audit-database-engine`
- CLR integration security: `learn.microsoft.com/sql/relational-databases/clr-integration/security/clr-integration-security`
- xp_cmdshell: `learn.microsoft.com/sql/relational-databases/system-stored-procedures/xp-cmdshell-transact-sql`
- SQL Agent security: `learn.microsoft.com/sql/ssms/agent/implement-sql-server-agent-security`
