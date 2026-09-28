#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

type BimDataType = "string" | "int64" | "double" | "boolean" | "dateTime";

type Annotation = {
	name: string;
	value: string;
};

type BimColumn = {
	name: string;
	dataType: BimDataType;
	sourceColumn: string;
	description?: string;
	formatString?: string;
};

type BimMeasure = {
	name: string;
	expression: string;
	description?: string;
	formatString?: string;
	displayFolder?: string;
};

type BimPartition = {
	name: string;
	mode: "directLake";
	source: {
		type: "entity";
		schemaName?: string;
		entityName: string;
	};
};

type BimTable = {
	name: string;
	description?: string;
	columns: BimColumn[];
	measures?: BimMeasure[];
	partitions: BimPartition[];
	annotations?: Annotation[];
};

type BimRelationship = {
	name: string;
	fromTable: string;
	fromColumn: string;
	toTable: string;
	toColumn: string;
	crossFilteringBehavior?: "oneDirection" | "bothDirections";
	isActive?: boolean;
};

type BimCulture = {
	name: string;
	linguisticMetadata?: {
		content?: unknown;
		contentType?: string;
	};
};

type BimRoot = {
	compatibilityLevel?: number;
	model: {
		culture?: string;
		defaultMode?: string;
		defaultPowerBIDataSourceVersion?: string;
		tables: BimTable[];
		relationships?: BimRelationship[];
		cultures?: BimCulture[];
	};
};

type InferredDataType = BimDataType | "empty";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
const semanticModelDir = join(repoRoot, "src", "fabric", "CaldovaLaunch.SemanticModel");
// model.bim is the authored source and lives OUTSIDE the item folder: Fabric
// rejects an item that contains both TMSL (model.bim) and TMDL definitions.
const sourceModelPath = join(repoRoot, "src", "fabric", "semantic-model-source", "model.bim");
const definitionRoot = join(semanticModelDir, "definition");
const dataRoots = [join(repoRoot, "data", "fabric-sql"), join(repoRoot, "data", "eventhouse")];
const placeholders = {
	host: "__SQL_ENDPOINT_HOST__",
	id: "__SQL_ENDPOINT_ID__",
};

function usage(): string {
	return [
		"Usage: node data/tools/build-semantic-model.ts [--sql-endpoint-host <host>] [--sql-endpoint-id <id>]",
		"",
		"Projects src/fabric/semantic-model-source/model.bim into Fabric Direct Lake TMDL.",
		"When an endpoint argument is omitted, placeholder tokens are emitted and must be replaced before deployment.",
	].join("\n");
}

function readCliOption(name: string): string | undefined {
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === name) {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error(`Missing value for ${name}`);
			}
			return value;
		}
		if (arg.startsWith(`${name}=`)) {
			const value = arg.slice(name.length + 1);
			if (!value) {
				throw new Error(`Missing value for ${name}`);
			}
			return value;
		}
	}
	return undefined;
}

function failForUnknownArgs(): void {
	const args = process.argv.slice(2);
	const knownOptions = new Set(["--sql-endpoint-host", "--sql-endpoint-id"]);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			console.log(usage());
			process.exit(0);
		}
		const [option] = arg.split("=", 1);
		if (!knownOptions.has(option)) {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
		if (!arg.includes("=")) {
			index += 1;
		}
	}
}

function compareNames(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function quoteTmdlName(name: string): string {
	if (!/[.\s=:'"]/.test(name)) {
		return name;
	}
	return `'${name.replaceAll("'", "''")}'`;
}

function formatReference(tableName: string, columnName: string): string {
	return `${quoteTmdlName(tableName)}.${quoteTmdlName(columnName)}`;
}

function formatTextProperty(value: string): string {
	if (/^\s|\s$|["\r\n]/.test(value)) {
		return `"${value.replaceAll('"', '""').replaceAll(/\r?\n/g, "\\n")}"`;
	}
	return value;
}

function formatMString(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function indentMultiline(value: string, depth: number): string {
	const prefix = "\t".repeat(depth);
	return value.replaceAll("\r\n", "\n").split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function assertKnownDataType(column: BimColumn, tableName: string): void {
	const supported = new Set<BimDataType>(["string", "int64", "double", "boolean", "dateTime"]);
	if (!supported.has(column.dataType)) {
		throw new Error(`Unsupported dataType ${column.dataType} on ${tableName}.${column.name}`);
	}
}

function parseCsv(text: string): string[][] {
	const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;

	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		if (inQuotes) {
			if (character === '"') {
				if (input[index + 1] === '"') {
					field += '"';
					index += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += character;
			}
			continue;
		}

		if (character === '"') {
			inQuotes = true;
		} else if (character === ",") {
			row.push(field);
			field = "";
		} else if (character === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (character === "\r") {
			if (input[index + 1] !== "\n") {
				row.push(field);
				rows.push(row);
				row = [];
				field = "";
			}
		} else {
			field += character;
		}
	}

	if (inQuotes) {
		throw new Error("Unclosed quoted field in CSV input");
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((parsedRow) => !(parsedRow.length === 1 && parsedRow[0] === ""));
}

async function readCsvRows(entityName: string): Promise<{ path: string; rows: string[][] } | undefined> {
	for (const dataRoot of dataRoots) {
		for (const extension of [".csv", ".csv.gz"]) {
			const path = join(dataRoot, `${entityName}${extension}`);
			try {
				const buffer = await readFile(path);
				const text = extension === ".csv.gz" ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
				return { path, rows: parseCsv(text) };
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					continue;
				}
				throw error;
			}
		}
	}
	return undefined;
}

function inferDataType(values: string[]): { type: InferredDataType; nonEmptyCount: number; samples: string[] } {
	const nonEmptyValues = values.map((value) => value.trim()).filter((value) => value !== "");
	const samples = [...new Set(nonEmptyValues)].slice(0, 8);
	if (nonEmptyValues.length === 0) {
		return { type: "empty", nonEmptyCount: 0, samples: [] };
	}
	if (nonEmptyValues.every((value) => /^(?:true|false)$/i.test(value))) {
		return { type: "boolean", nonEmptyCount: nonEmptyValues.length, samples };
	}
	if (nonEmptyValues.every((value) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) {
		const isInt64 = nonEmptyValues.every(
			(value) => /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value)),
		);
		return { type: isInt64 ? "int64" : "double", nonEmptyCount: nonEmptyValues.length, samples };
	}
	if (
		nonEmptyValues.every(
			(value) =>
				/^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
					value,
				) && !Number.isNaN(Date.parse(value)),
		)
	) {
		return { type: "dateTime", nonEmptyCount: nonEmptyValues.length, samples };
	}
	return { type: "string", nonEmptyCount: nonEmptyValues.length, samples };
}

async function auditColumnTypes(tables: BimTable[]): Promise<void> {
	const mismatches: string[] = [];
	const emptyColumns: string[] = [];
	const missingInputs: string[] = [];

	for (const table of tables) {
		if (table.partitions.length !== 1) {
			missingInputs.push(`${table.name}: expected one partition for CSV type audit, found ${table.partitions.length}`);
			continue;
		}

		const entityName = table.partitions[0].source.entityName;
		const data = await readCsvRows(entityName);
		if (!data) {
			missingInputs.push(`${table.name}: no CSV source found for partition entity ${entityName}`);
			continue;
		}
		const [headers, ...rows] = data.rows;
		if (!headers) {
			missingInputs.push(`${table.name}: ${data.path} is empty`);
			continue;
		}
		const headerIndexes = new Map(headers.map((header, index) => [header, index]));
		for (const [rowIndex, row] of rows.entries()) {
			if (row.length !== headers.length) {
				missingInputs.push(
					`${table.name}: ${data.path} row ${rowIndex + 2} has ${row.length} fields, expected ${headers.length}`,
				);
			}
		}

		for (const column of table.columns) {
			assertKnownDataType(column, table.name);
			const columnIndex = headerIndexes.get(column.sourceColumn);
			if (columnIndex === undefined) {
				missingInputs.push(`${table.name}.${column.name}: source column ${column.sourceColumn} not found in ${data.path}`);
				continue;
			}
			const inferred = inferDataType(rows.map((row) => row[columnIndex] ?? ""));
			// Declaring double while a given slice happens to hold only whole numbers
			// is safe widening, not a defect: decision_outcomes.plannedValue is double
			// because the reveal carries 111.26, even though the default slice holds
			// only integers. Narrowing - declared int64, observed fractional - is a
			// real error and still fails.
			const isSafeWidening = column.dataType === "double" && inferred.type === "int64";
			if (inferred.type === "empty") {
				emptyColumns.push(`${table.name}.${column.name}`);
			} else if (inferred.type !== column.dataType && !isSafeWidening) {
				mismatches.push(
					`${table.name}.${column.name}: declared ${column.dataType}, inferred ${inferred.type} from ${inferred.nonEmptyCount} non-empty value(s), samples: ${inferred.samples.join(", ")}`,
				);
			}
		}
	}

	if (missingInputs.length > 0 || mismatches.length > 0) {
		const details = [
			...missingInputs.map((message) => `- ${message}`),
			...mismatches.map((message) => `- ${message}`),
		];
		throw new Error(`Semantic model column type audit failed:\n${details.join("\n")}`);
	}
	if (emptyColumns.length > 0) {
		console.warn(`Warning: skipped type inference for all-empty column(s): ${emptyColumns.join(", ")}`);
	}
}

function emitDatabase(root: BimRoot): string {
	const compatibilityLevel = root.compatibilityLevel ?? 1604;
	return `database\n\tcompatibilityLevel: ${compatibilityLevel}\n\n`;
}

function emitModel(model: BimRoot["model"], tables: BimTable[]): string {
	const lines = [
		"model Model",
		`\tdefaultMode: ${model.defaultMode ?? "directLake"}`,
		`\tculture: ${model.culture ?? "en-US"}`,
		`\tdefaultPowerBIDataSourceVersion: ${model.defaultPowerBIDataSourceVersion ?? "powerBI_V3"}`,
		"",
	];
	for (const table of tables) {
		lines.push(`ref table ${quoteTmdlName(table.name)}`);
	}
	return `${lines.join("\n")}\n\n`;
}

function emitExpressions(sqlEndpointHost: string, sqlEndpointId: string): string {
	return [
		"expression DatabaseQuery =",
		`\t\tlet`,
		`\t\t    database = Sql.Database(${formatMString(sqlEndpointHost)}, ${formatMString(sqlEndpointId)})`,
		`\t\tin`,
		`\t\t    database`,
		"",
	].join("\n");
}

// TMDL expresses descriptions as `///` comment lines immediately preceding the
// object, not as a `description:` property. The property form is valid TMSL but
// the TMDL parser rejects it with
// "Unsupported property - description is not a supported property".
function emitDescriptionComment(text: string, indent: string): string[] {
	return text
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => `${indent}/// ${line}`.trimEnd());
}

function emitColumn(table: BimTable, column: BimColumn): string {
	assertKnownDataType(column, table.name);
	const lines = [
		`\tcolumn ${quoteTmdlName(column.name)}`,
		`\t\tdataType: ${column.dataType}`,
		`\t\tsourceColumn: ${formatTextProperty(column.sourceColumn)}`,
	];
	if (column.formatString) {
		lines.push(`\t\tformatString: ${formatTextProperty(column.formatString)}`);
	}
	if (column.description) {
		return [...emitDescriptionComment(column.description, "\t"), ...lines].join("\n");
	}
	return lines.join("\n");
}

function emitMeasure(measure: BimMeasure): string {
	const expression = measure.expression.replaceAll("\r\n", "\n");
	const lines: string[] = [];
	if (expression.includes("\n")) {
		lines.push(`\tmeasure ${quoteTmdlName(measure.name)} =`);
		lines.push(indentMultiline(expression, 3));
	} else {
		lines.push(`\tmeasure ${quoteTmdlName(measure.name)} = ${expression}`);
	}
	if (measure.formatString) {
		lines.push(`\t\tformatString: ${formatTextProperty(measure.formatString)}`);
	}
	if (measure.displayFolder) {
		lines.push(`\t\tdisplayFolder: ${formatTextProperty(measure.displayFolder)}`);
	}
	if (measure.description) {
		return [...emitDescriptionComment(measure.description, "\t"), ...lines].join("\n");
	}
	return lines.join("\n");
}

function emitPartition(table: BimTable): string {
	if (table.partitions.length !== 1) {
		throw new Error(`Expected exactly one Direct Lake partition for ${table.name}, found ${table.partitions.length}`);
	}
	const partition = table.partitions[0];
	if (partition.mode !== "directLake" || partition.source.type !== "entity") {
		throw new Error(`Unsupported partition on ${table.name}; only Direct Lake entity partitions can be emitted`);
	}
	const partitionName = partition.source.entityName;
	const schemaName = partition.source.schemaName ?? "dbo";
	return [
		`\tpartition ${quoteTmdlName(partitionName)} = entity`,
		`\t\tmode: directLake`,
		`\t\tsource`,
		`\t\t\tentityName: ${formatTextProperty(partition.source.entityName)}`,
		`\t\t\tschemaName: ${formatTextProperty(schemaName)}`,
		`\t\t\texpressionSource: DatabaseQuery`,
	].join("\n");
}

function emitTable(table: BimTable): string {
	const header = table.description
		? [...emitDescriptionComment(table.description, ""), `table ${quoteTmdlName(table.name)}`].join("\n")
		: `table ${quoteTmdlName(table.name)}`;
	const blocks: string[] = [header];
	for (const column of table.columns) {
		blocks.push(emitColumn(table, column));
	}
	for (const measure of table.measures ?? []) {
		blocks.push(emitMeasure(measure));
	}
	blocks.push(emitPartition(table));
	return `${blocks.join("\n\n")}\n`;
}

function emitRelationships(relationships: BimRelationship[] = []): string {
	const blocks = [...relationships]
		.sort((left, right) => compareNames(left.name, right.name))
		.map((relationship) => {
			const lines = [
				`relationship ${quoteTmdlName(relationship.name)}`,
				`\tfromColumn: ${formatReference(relationship.fromTable, relationship.fromColumn)}`,
				`\ttoColumn: ${formatReference(relationship.toTable, relationship.toColumn)}`,
			];
			if (relationship.isActive === false) {
				lines.push(`\tisActive: false`);
			}
			if (relationship.crossFilteringBehavior === "bothDirections") {
				lines.push(`\tcrossFilteringBehavior: bothDirections`);
			}
			return lines.join("\n");
		});
	return `${blocks.join("\n\n")}\n`;
}

function emitCulture(culture: BimCulture): string {
	const metadata = culture.linguisticMetadata;
	const blocks = [`culture ${quoteTmdlName(culture.name)}`];
	if (metadata?.content !== undefined) {
		const content = JSON.stringify(metadata.content, null, 2);
		// `contentType` must be nested UNDER linguisticMetadata, not at culture
		// level. At culture level TMDL rejects it as an unsupported property; if
		// omitted entirely TMDL assumes XML and rejects the JSON payload.
		blocks.push(
			`\tlinguisticMetadata =\n${indentMultiline(content, 2)}\n\n\t\tcontentType: json`,
		);
	}
	// `contentType` is valid in TMSL but rejected by the TMDL parser:
	// "Unsupported property - contentType is not a supported property in the
	// current context". The linguisticMetadata block is self-describing, so it
	// is deliberately not emitted.
	return `${blocks.join("\n")}\n`;
}

async function writeText(path: string, content: string): Promise<void> {
	await writeFile(path, content.replaceAll("\r\n", "\n"), "utf8");
}

async function main(): Promise<void> {
	failForUnknownArgs();

	const sqlEndpointHost = readCliOption("--sql-endpoint-host") ?? placeholders.host;
	const sqlEndpointId = readCliOption("--sql-endpoint-id") ?? placeholders.id;
	if (sqlEndpointHost === placeholders.host || sqlEndpointId === placeholders.id) {
		console.warn(
			"Warning: SQL endpoint host/id not fully supplied; emitted __SQL_ENDPOINT_HOST__ / __SQL_ENDPOINT_ID__ placeholders that must be replaced before deployment.",
		);
	}

	const root = JSON.parse(await readFile(sourceModelPath, "utf8")) as BimRoot;
	const tables = [...root.model.tables].sort((left, right) => compareNames(left.name, right.name));
	// Linguistic metadata (synonyms) is opt-in via --with-cultures. The Fabric
	// TMDL parser rejects the JSON linguisticMetadata payload that TMSL accepts:
	// without `contentType` it assumes XML, and `contentType` is refused as an
	// unsupported property at both culture and property level. Measures, table
	// and column descriptions -- the primary agent-grounding surface -- are
	// unaffected and always emitted.
	const withCultures = process.argv.includes("--with-cultures");
	const cultures = withCultures
		? [...(root.model.cultures ?? [])].sort((left, right) => compareNames(left.name, right.name))
		: [];

	await auditColumnTypes(tables);

	await rm(definitionRoot, { recursive: true, force: true });
	await mkdir(join(definitionRoot, "tables"), { recursive: true });
	if (cultures.length > 0) {
		await mkdir(join(definitionRoot, "cultures"), { recursive: true });
	}

	await writeText(
		join(semanticModelDir, "definition.pbism"),
		`${JSON.stringify(
			{
				$schema: "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
				version: "4.2",
				settings: {},
			},
			null,
			2,
		)}\n`,
	);
	await writeText(join(definitionRoot, "database.tmdl"), emitDatabase(root));
	await writeText(join(definitionRoot, "model.tmdl"), emitModel(root.model, tables));
	await writeText(join(definitionRoot, "expressions.tmdl"), emitExpressions(sqlEndpointHost, sqlEndpointId));
	await writeText(join(definitionRoot, "relationships.tmdl"), emitRelationships(root.model.relationships));
	for (const table of tables) {
		await writeText(join(definitionRoot, "tables", `${table.name}.tmdl`), emitTable(table));
	}
	for (const culture of cultures) {
		await writeText(join(definitionRoot, "cultures", `${culture.name}.tmdl`), emitCulture(culture));
	}

	const measureCount = tables.reduce((count, table) => count + (table.measures?.length ?? 0), 0);
	console.log(
		`Generated ${tables.length} tables, ${measureCount} measures, ${root.model.relationships?.length ?? 0} relationships, and ${cultures.length} culture file(s).`,
	);
}

await main();
