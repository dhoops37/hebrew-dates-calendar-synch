/**
 * Schema parity: the Kysely types must match the migrated database.
 *
 * `src/schema.ts` is a hand-maintained mirror of `db/migrations/*.sql`, and the
 * SQL is authoritative. A hand-maintained mirror drifts — someone adds a column
 * in a migration and forgets the interface, or renames one in the interface and
 * the queries silently compile against a column that does not exist. So the
 * types are parsed here with the TypeScript compiler and compared against
 * `information_schema` from a freshly migrated database, in both directions.
 *
 * This is the test referenced in the header of `src/schema.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_TABLES, describeSchema, type ColumnInfo } from '../../src/migrate';
import { createTestDatabase, describeWithDatabase, type TestDatabase } from '../helpers/database';

const SCHEMA_PATH = fileURLToPath(new URL('../../src/schema.ts', import.meta.url));

interface DeclaredColumn {
  name: string;
  typeText: string;
  nullable: boolean;
  /** True when the column may be omitted on insert, i.e. it has a default. */
  optionalOnInsert: boolean;
}

/**
 * Read the Kysely interfaces out of `schema.ts`.
 *
 * Deliberately syntactic rather than a full type-check: what matters is the
 * declared shape, and resolving `ColumnType` through the checker would couple
 * this test to Kysely's internals. Nullability is read from the select type —
 * the first `ColumnType` argument, or the type itself — because that is what a
 * `SELECT` actually hands back.
 */
function parseSchemaTypes(): {
  tables: Map<string, string>;
  interfaces: Map<string, DeclaredColumn[]>;
} {
  const source = ts.createSourceFile(
    SCHEMA_PATH,
    readFileSync(SCHEMA_PATH, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );

  /** Local aliases such as `TimestampNullable`, and whether they admit null. */
  const aliasNullability = new Map<string, boolean>();
  /** The same aliases, and whether they may be omitted on insert. */
  const aliasHasDefault = new Map<string, boolean>();
  const interfaces = new Map<string, DeclaredColumn[]>();
  const tables = new Map<string, string>();

  const admitsNull = (node: ts.TypeNode): boolean => {
    if (ts.isUnionTypeNode(node)) return node.types.some(admitsNull);
    if (node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return true;
    return false;
  };

  /** The type a `SELECT` yields: `ColumnType`'s first argument, else the type. */
  const selectType = (node: ts.TypeNode): ts.TypeNode => {
    if (ts.isTypeReferenceNode(node) && node.typeArguments) {
      const name = node.typeName.getText();
      if (name === 'ColumnType') return node.typeArguments[0] ?? node;
      if (name === 'Generated') return selectType(node.typeArguments[0] ?? node);
    }
    return node;
  };

  const isNullable = (node: ts.TypeNode): boolean => {
    const selected = selectType(node);
    if (admitsNull(selected)) return true;
    if (ts.isTypeReferenceNode(selected) && !selected.typeArguments) {
      return aliasNullability.get(selected.typeName.getText()) ?? false;
    }
    return false;
  };

  const hasDefault = (node: ts.TypeNode): boolean => {
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText();
      if (name === 'Generated') return true;
      // A `ColumnType` whose insert type admits `undefined` may be omitted.
      if (name === 'ColumnType' && node.typeArguments?.[1]) {
        const insertType = node.typeArguments[1];
        if (
          ts.isUnionTypeNode(insertType) &&
          insertType.types.some((member) => member.kind === ts.SyntaxKind.UndefinedKeyword)
        ) {
          return true;
        }
      }
      if (!node.typeArguments) {
        return aliasHasDefault.get(name) ?? false;
      }
    }
    return false;
  };

  // Pass one: type aliases, so interface properties can resolve them.
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      aliasNullability.set(statement.name.text, isNullable(statement.type));
      aliasHasDefault.set(statement.name.text, hasDefault(statement.type));
    }
  }

  // Pass two: interfaces.
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;

    const columns: DeclaredColumn[] = [];
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const name = member.name.getText().replace(/^['"]|['"]$/g, '');

      if (statement.name.text === 'Database') {
        tables.set(name, member.type.getText());
        continue;
      }

      columns.push({
        name,
        typeText: member.type.getText(),
        nullable: isNullable(member.type),
        optionalOnInsert: hasDefault(member.type) || member.questionToken !== undefined,
      });
    }
    if (statement.name.text !== 'Database') {
      interfaces.set(statement.name.text, columns);
    }
  }

  return { tables, interfaces };
}

describe.runIf(describeWithDatabase)('schema parity', () => {
  let harness: TestDatabase;
  let catalogue: ColumnInfo[];
  let parsed: ReturnType<typeof parseSchemaTypes>;

  beforeAll(async () => {
    harness = await createTestDatabase('parity');
    catalogue = await describeSchema(harness.db);
    parsed = parseSchemaTypes();
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  it('parses the schema types at all, so a silent no-op cannot pass', () => {
    // Without this, a parser that found nothing would make every comparison
    // below trivially true.
    expect(parsed.tables.size).toBeGreaterThan(10);
    expect(parsed.interfaces.size).toBeGreaterThan(10);
  });

  it('migrates exactly the tables the runner expects', () => {
    const live = [...new Set(catalogue.map((column) => column.table_name))].sort();
    expect(live).toEqual([...EXPECTED_TABLES].sort());
  });

  it('declares a Kysely table for every migrated table, and no extras', () => {
    const live = [...new Set(catalogue.map((column) => column.table_name))].sort();
    const declared = [...parsed.tables.keys()].sort();
    expect(declared).toEqual(live);
  });

  it('points every Database entry at an interface that exists', () => {
    for (const [table, interfaceName] of parsed.tables) {
      expect(parsed.interfaces.has(interfaceName), `${table} -> ${interfaceName}`).toBe(true);
    }
  });

  describe('per table', () => {
    it.each([...EXPECTED_TABLES])('%s has matching columns', (table) => {
      const interfaceName = parsed.tables.get(table);
      expect(interfaceName, `no Kysely entry for table "${table}"`).toBeDefined();
      const declared = parsed.interfaces.get(interfaceName as string) ?? [];

      const liveColumns = catalogue
        .filter((column) => column.table_name === table)
        .map((column) => column.column_name)
        .sort();
      const declaredColumns = declared.map((column) => column.name).sort();

      expect(declaredColumns).toEqual(liveColumns);
    });

    it.each([...EXPECTED_TABLES])('%s has matching nullability', (table) => {
      const interfaceName = parsed.tables.get(table) as string;
      const byName = new Map(
        (parsed.interfaces.get(interfaceName) ?? []).map((column) => [column.name, column] as const),
      );

      const mismatches: string[] = [];
      for (const column of catalogue.filter((row) => row.table_name === table)) {
        const declaredColumn = byName.get(column.column_name);
        if (!declaredColumn) continue;
        const liveNullable = column.is_nullable === 'YES';
        if (declaredColumn.nullable !== liveNullable) {
          mismatches.push(
            `${table}.${column.column_name}: database ${
              liveNullable ? 'nullable' : 'NOT NULL'
            }, types say ${declaredColumn.nullable ? 'nullable' : 'NOT NULL'} (${
              declaredColumn.typeText
            })`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });

    it.each([...EXPECTED_TABLES])('%s marks defaulted columns as optional on insert', (table) => {
      const interfaceName = parsed.tables.get(table) as string;
      const byName = new Map(
        (parsed.interfaces.get(interfaceName) ?? []).map((column) => [column.name, column] as const),
      );

      // A column with a database default must be omissible on insert, or every
      // insert has to spell out `created_at`. The converse is not asserted: a
      // nullable column with no default is legitimately optional too.
      const missing: string[] = [];
      for (const column of catalogue.filter((row) => row.table_name === table)) {
        const declaredColumn = byName.get(column.column_name);
        if (!declaredColumn) continue;
        const hasDatabaseDefault = column.column_default !== null;
        if (hasDatabaseDefault && !declaredColumn.optionalOnInsert && !declaredColumn.nullable) {
          missing.push(
            `${table}.${column.column_name} defaults to ${column.column_default} but the type ` +
              `(${declaredColumn.typeText}) requires it on insert`,
          );
        }
      }
      expect(missing).toEqual([]);
    });
  });

  it('keeps coordinates as numeric, not a floating-point type', () => {
    // The one value in this system that must survive a round trip exactly.
    const coordinates = catalogue.filter(
      (column) =>
        column.table_name === 'calendar_locations' &&
        (column.column_name === 'latitude' || column.column_name === 'longitude'),
    );
    expect(coordinates).toHaveLength(2);
    expect(coordinates.every((column) => column.data_type === 'numeric')).toBe(true);
  });

  it('keeps calendar days as date and instants as timestamptz', () => {
    const byKey = new Map(
      catalogue.map((column) => [`${column.table_name}.${column.column_name}`, column.data_type]),
    );
    // A Gregorian calendar day is not an instant. Storing either of these as
    // timestamptz is the timezone bug the engine exists to avoid.
    expect(byKey.get('generated_occurrences.gregorian_date')).toBe('date');
    expect(byKey.get('source_records.original_gregorian_date')).toBe('date');
    // The sunset window, by contrast, is a real instant.
    expect(byKey.get('destination_events.start_at')).toBe('timestamp with time zone');
    expect(byKey.get('destination_events.end_at')).toBe('timestamp with time zone');
  });

  it('stores secrets as bytea, never text', () => {
    const byKey = new Map(
      catalogue.map((column) => [`${column.table_name}.${column.column_name}`, column.data_type]),
    );
    // Ciphertext and hashes only. A text column here would invite someone to
    // write a plaintext token into it.
    expect(byKey.get('sessions.id')).toBe('bytea');
    expect(byKey.get('oauth_states.state_hash')).toBe('bytea');
    expect(byKey.get('oauth_states.encrypted_code_verifier')).toBe('bytea');
    expect(byKey.get('google_accounts.encrypted_refresh_token')).toBe('bytea');
  });

  it('has no column that looks like a plaintext credential', () => {
    // A blunt instrument, on purpose: it fires if someone adds
    // `refresh_token` or `access_token` as a bare column later.
    const suspicious = catalogue.filter((column) =>
      /^(refresh_token|access_token|password|secret|api_key|client_secret)$/.test(
        column.column_name,
      ),
    );
    expect(suspicious.map((column) => `${column.table_name}.${column.column_name}`)).toEqual([]);
  });
});
