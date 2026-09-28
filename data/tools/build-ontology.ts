#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTITY_SCHEMA =
  'https://developer.microsoft.com/json-schemas/fabric/item/ontology/entityType/1.0.0/schema.json';
const RELATIONSHIP_SCHEMA =
  'https://developer.microsoft.com/json-schemas/fabric/item/ontology/relationshipType/1.0.0/schema.json';
const ACCEPTED_VALUE_TYPES = new Set(['String', 'Boolean', 'Double', 'DateTime', 'Float']);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const ontologyRoot = join(repoRoot, 'src/fabric/CaldovaLaunch.Ontology');
const bindingsPath = join(ontologyRoot, 'bindings.json');
const BINDING_PLACEHOLDERS = {
  eventhouseId: '__EVENTHOUSE_ID__',
  clusterUri: '__KUSTO_CLUSTER_URI__',
  databaseName: '__KQL_DATABASE__',
};

type JsonObject = Record<string, unknown>;

type CliOptions = {
  checkOnly: boolean;
  bindingsOutput?: string;
  eventhouseId?: string;
  clusterUri?: string;
  databaseName?: string;
};

type DefinitionFile = {
  absolutePath: string;
  kind: 'entity' | 'relationship';
  schema: string;
};

type PlannedWrite = {
  absolutePath: string;
  content: string;
};

type UnsupportedValueType = {
  file: string;
  property: string;
  valueType: string;
};

type BindingValidation = {
  errors: string[];
  kustoSourceBlocks: number;
};

function usage(): string {
  return [
    'Usage: node data/tools/build-ontology.ts [--check] [--bindings-output <path>] [--eventhouse <id>] [--cluster-uri <uri>] [--database <name>]',
    '',
    'Normalizes Fabric ontology definitions and validates src/fabric/CaldovaLaunch.Ontology/bindings.json.',
    'With --bindings-output, writes a deploy-ready binding map with Eventhouse placeholders substituted.',
    'Omitted Eventhouse arguments leave __EVENTHOUSE_ID__, __KUSTO_CLUSTER_URI__, and __KQL_DATABASE__ placeholders in the output.',
  ].join('\n');
}

function readOptionValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const arg = args[index];
  if (arg.startsWith(`${option}=`)) {
    const value = arg.slice(option.length + 1);
    if (!value) throw new Error(`Missing value for ${option}`);
    return { value, nextIndex: index };
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`);
  }
  return { value, nextIndex: index + 1 };
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = { checkOnly: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [option] = arg.split('=', 1);

    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--check') {
      options.checkOnly = true;
      continue;
    }

    if (option === '--bindings-output') {
      const result = readOptionValue(args, index, option);
      options.bindingsOutput = result.value;
      index = result.nextIndex;
      continue;
    }
    if (option === '--eventhouse' || option === '--eventhouse-id') {
      const result = readOptionValue(args, index, option);
      options.eventhouseId = result.value;
      index = result.nextIndex;
      continue;
    }
    if (option === '--cluster-uri') {
      const result = readOptionValue(args, index, option);
      options.clusterUri = result.value;
      index = result.nextIndex;
      continue;
    }
    if (option === '--database') {
      const result = readOptionValue(args, index, option);
      options.databaseName = result.value;
      index = result.nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  return options;
}

function relativeDisplay(absolutePath: string): string {
  return relative(repoRoot, absolutePath).split('\\').join('/');
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function listDefinitionFiles(
  directory: string,
  kind: 'entity' | 'relationship',
  schema: string,
): Promise<DefinitionFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      absolutePath: join(directory, name, 'definition.json'),
      kind,
      schema,
    }));
}

function ensureSchemaFirst(definition: JsonObject, schema: string): { definition: JsonObject; changed: boolean } {
  if (!Object.prototype.hasOwnProperty.call(definition, '$schema')) {
    return {
      definition: { $schema: schema, ...definition },
      changed: true,
    };
  }

  if (definition.$schema !== schema) {
    definition.$schema = schema;
    return { definition, changed: true };
  }

  return { definition, changed: false };
}

function propertyName(value: JsonObject, fallback: string): string {
  if (typeof value.name === 'string') return value.name;
  if (typeof value.id === 'string') return value.id;
  return fallback;
}

function displayValueType(valueType: unknown): string {
  if (typeof valueType === 'string') return valueType;
  if (valueType === undefined) return '<missing>';
  return JSON.stringify(valueType) ?? String(valueType);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? value : null;
}

function convertCollection(
  definition: JsonObject,
  collectionName: 'properties' | 'timeseriesProperties',
  checkOnly: boolean,
): number {
  const collection = definition[collectionName];
  if (collection === undefined) return 0;
  if (!Array.isArray(collection)) {
    throw new Error(`${collectionName} must be an array when present.`);
  }

  let converted = 0;
  for (const item of collection) {
    if (!isJsonObject(item)) {
      throw new Error(`${collectionName} entries must be JSON objects.`);
    }
    if (item.valueType === 'Int64') {
      converted += 1;
      if (!checkOnly) item.valueType = 'Double';
    }
  }

  return converted;
}

function convertDateTimeEntityKeys(definition: JsonObject, file: string, checkOnly: boolean): number {
  const entityIdParts = definition.entityIdParts;
  if (entityIdParts === undefined) return 0;
  if (!Array.isArray(entityIdParts) || !entityIdParts.every((id) => typeof id === 'string')) {
    throw new Error(`${file}: entityIdParts must be an array of property ID strings.`);
  }

  const properties = definition.properties;
  if (!Array.isArray(properties)) {
    throw new Error(`${file}: properties must be an array when entityIdParts is present.`);
  }

  const propertiesById = new Map<string, JsonObject>();
  for (const property of properties) {
    if (!isJsonObject(property) || typeof property.id !== 'string') continue;
    propertiesById.set(property.id, property);
  }

  let converted = 0;
  for (const propertyId of entityIdParts) {
    const property = propertiesById.get(propertyId);
    if (!property) {
      throw new Error(`${file}: entityIdParts references missing property ${propertyId}.`);
    }
    if (property.valueType === 'DateTime') {
      converted += 1;
      if (!checkOnly) property.valueType = 'String';
    } else if (property.valueType !== 'String') {
      throw new Error(
        `${file}: entityIdParts references ${propertyName(property, propertyId)} with valueType ${displayValueType(
          property.valueType,
        )}; Fabric keys must be String after conversion.`,
      );
    }
  }

  return converted;
}

function collectUnsupportedValueTypes(
  value: unknown,
  file: string,
  path: string,
  unsupported: UnsupportedValueType[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnsupportedValueTypes(item, file, `${path}[${index}]`, unsupported));
    return;
  }

  if (!isJsonObject(value)) return;

  if (Object.prototype.hasOwnProperty.call(value, 'valueType')) {
    const valueType = value.valueType;
    if (typeof valueType !== 'string' || !ACCEPTED_VALUE_TYPES.has(valueType)) {
      unsupported.push({
        file,
        property: propertyName(value, path),
        valueType: displayValueType(valueType),
      });
    }
  }

  for (const [key, child] of Object.entries(value)) {
    collectUnsupportedValueTypes(child, file, path ? `${path}.${key}` : key, unsupported);
  }
}

async function processDefinitionFile(
  definitionFile: DefinitionFile,
  checkOnly: boolean,
): Promise<{
  converted: number;
  keyDateTimesConverted: number;
  needsWrite: boolean;
  plannedWrite: PlannedWrite | null;
  unsupported: UnsupportedValueType[];
}> {
  const original = await readFile(definitionFile.absolutePath, 'utf8');
  const parsed = JSON.parse(original) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`${relativeDisplay(definitionFile.absolutePath)} must contain a JSON object.`);
  }

  const schemaResult = ensureSchemaFirst(parsed, definitionFile.schema);
  const converted =
    convertCollection(schemaResult.definition, 'properties', checkOnly) +
    convertCollection(schemaResult.definition, 'timeseriesProperties', checkOnly);
  const keyDateTimesConverted =
    definitionFile.kind === 'entity'
      ? convertDateTimeEntityKeys(schemaResult.definition, relativeDisplay(definitionFile.absolutePath), checkOnly)
      : 0;
  const unsupported: UnsupportedValueType[] = [];
  collectUnsupportedValueTypes(
    schemaResult.definition,
    relativeDisplay(definitionFile.absolutePath),
    '',
    unsupported,
  );

  const content = `${JSON.stringify(schemaResult.definition, null, 2)}\n`;
  const needsWrite = schemaResult.changed || converted > 0 || keyDateTimesConverted > 0 || original !== content;

  return {
    converted,
    keyDateTimesConverted,
    needsWrite,
    plannedWrite: needsWrite ? { absolutePath: definitionFile.absolutePath, content } : null,
    unsupported,
  };
}

function printUnsupported(unsupported: UnsupportedValueType[]): void {
  if (unsupported.length === 0) return;

  console.error('Unsupported valueTypes:');
  for (const item of unsupported) {
    console.error(`  ${item.file}: ${item.property} uses ${item.valueType}`);
  }
}

async function loadEntityDefinitions(): Promise<Map<string, JsonObject>> {
  const definitionFiles = await listDefinitionFiles(join(ontologyRoot, 'EntityTypes'), 'entity', ENTITY_SCHEMA);
  const definitions = new Map<string, JsonObject>();

  for (const definitionFile of definitionFiles) {
    const parsed = JSON.parse(await readFile(definitionFile.absolutePath, 'utf8')) as unknown;
    if (!isJsonObject(parsed) || typeof parsed.name !== 'string') {
      throw new Error(`${relativeDisplay(definitionFile.absolutePath)} must contain a named entity definition.`);
    }
    definitions.set(parsed.name, parsed);
  }

  return definitions;
}

function sourceType(source: unknown): string | undefined {
  return isJsonObject(source) && typeof source.type === 'string' ? source.type : undefined;
}

function propertyNamesByKeyStatus(definition: JsonObject): { keyNames: Set<string>; timeseriesNames: Set<string>; staticNames: Set<string> } {
  const properties = Array.isArray(definition.properties) ? definition.properties : [];
  const timeseriesProperties = Array.isArray(definition.timeseriesProperties) ? definition.timeseriesProperties : [];
  const entityIdParts = stringArray(definition.entityIdParts) ?? [];

  const staticById = new Map<string, string>();
  const staticNames = new Set<string>();
  for (const property of properties) {
    if (!isJsonObject(property) || typeof property.id !== 'string' || typeof property.name !== 'string') continue;
    staticById.set(property.id, property.name);
    staticNames.add(property.name);
  }

  const keyNames = new Set<string>();
  for (const propertyId of entityIdParts) {
    const name = staticById.get(propertyId);
    if (name) keyNames.add(name);
  }

  const timeseriesNames = new Set<string>();
  for (const property of timeseriesProperties) {
    if (isJsonObject(property) && typeof property.name === 'string') timeseriesNames.add(property.name);
  }

  return { keyNames, timeseriesNames, staticNames };
}

function validateKustoSource(source: JsonObject, location: string, errors: string[]): void {
  for (const field of ['itemId', 'clusterUri', 'databaseName']) {
    if (typeof source[field] !== 'string' || source[field] === '') {
      errors.push(`${location}.source.${field} is required for KustoTable bindings.`);
    }
  }
}

function validateBindingMap(bindings: JsonObject, entityDefinitions: Map<string, JsonObject>): BindingValidation {
  const errors: string[] = [];
  let kustoSourceBlocks = 0;

  const entities = isJsonObject(bindings.entities) ? bindings.entities : {};
  for (const [entityName, entityMap] of Object.entries(entities)) {
    if (!isJsonObject(entityMap)) {
      errors.push(`entities.${entityName} must be an object.`);
      continue;
    }
    const definition = entityDefinitions.get(entityName);
    if (!definition) {
      errors.push(`entities.${entityName} does not match a local entity definition.`);
      continue;
    }

    const bindingsList = Array.isArray(entityMap.bindings) ? entityMap.bindings : [entityMap];
    const { keyNames, timeseriesNames, staticNames } = propertyNamesByKeyStatus(definition);
    for (const [bindingIndex, binding] of bindingsList.entries()) {
      if (!isJsonObject(binding)) {
        errors.push(`entities.${entityName}.bindings[${bindingIndex}] must be an object.`);
        continue;
      }

      const location = Array.isArray(entityMap.bindings)
        ? `entities.${entityName}.bindings[${bindingIndex}]`
        : `entities.${entityName}`;
      if (isJsonObject(binding.source) && sourceType(binding.source) === 'KustoTable') {
        kustoSourceBlocks += 1;
        validateKustoSource(binding.source, location, errors);
      }

      if (binding.dataBindingType !== 'TimeSeries') continue;
      if (typeof binding.timestampColumn !== 'string' || binding.timestampColumn === '') {
        errors.push(`${location}.timestampColumn is required for TimeSeries bindings.`);
      }

      const propertyNames = new Set<string>();
      const listedProperties = stringArray(binding.properties);
      if (binding.properties !== undefined && !listedProperties) {
        errors.push(`${location}.properties must be an array of strings when present.`);
      }
      for (const propertyName of listedProperties ?? []) propertyNames.add(propertyName);

      if (isJsonObject(binding.columns)) {
        for (const propertyName of Object.keys(binding.columns)) propertyNames.add(propertyName);
      }

      for (const propertyName of propertyNames) {
        if (timeseriesNames.has(propertyName) || keyNames.has(propertyName)) continue;
        if (staticNames.has(propertyName)) {
          errors.push(`${location} maps static non-key property ${propertyName}; TimeSeries bindings may only map entity keys and timeseriesProperties.`);
        } else {
          errors.push(`${location} maps unknown property ${propertyName}.`);
        }
      }
    }
  }

  const relationships = isJsonObject(bindings.relationships) ? bindings.relationships : {};
  for (const [relationshipName, relationshipMap] of Object.entries(relationships)) {
    if (!isJsonObject(relationshipMap)) {
      errors.push(`relationships.${relationshipName} must be an object.`);
      continue;
    }
    if (sourceType(relationshipMap.source) === 'KustoTable') {
      kustoSourceBlocks += 1;
      errors.push(`relationships.${relationshipName} uses KustoTable; Fabric relationship contextualizations require LakehouseTable.`);
    }
  }

  return { errors, kustoSourceBlocks };
}

function replacePlaceholders(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return replacements.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, replacements));
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const replaced: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    replaced[key] = replacePlaceholders(child, replacements);
  }
  return replaced;
}

async function processBindingMap(options: CliOptions, entityDefinitions: Map<string, JsonObject>): Promise<BindingValidation> {
  const parsed = JSON.parse(await readFile(bindingsPath, 'utf8')) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`${relativeDisplay(bindingsPath)} must contain a JSON object.`);
  }

  const replacements = new Map<string, string>();
  if (options.eventhouseId) replacements.set(BINDING_PLACEHOLDERS.eventhouseId, options.eventhouseId);
  if (options.clusterUri) replacements.set(BINDING_PLACEHOLDERS.clusterUri, options.clusterUri);
  if (options.databaseName) replacements.set(BINDING_PLACEHOLDERS.databaseName, options.databaseName);

  const resolved = replacePlaceholders(parsed, replacements);
  if (!isJsonObject(resolved)) {
    throw new Error(`${relativeDisplay(bindingsPath)} did not resolve to a JSON object.`);
  }

  const validation = validateBindingMap(resolved, entityDefinitions);

  if (options.bindingsOutput && validation.errors.length === 0) {
    const missing = [
      [BINDING_PLACEHOLDERS.eventhouseId, options.eventhouseId],
      [BINDING_PLACEHOLDERS.clusterUri, options.clusterUri],
      [BINDING_PLACEHOLDERS.databaseName, options.databaseName],
    ].filter(([, value]) => !value);
    if (missing.length > 0) {
      console.warn(`Warning: emitted binding map still contains placeholder(s): ${missing.map(([name]) => name).join(', ')}`);
    }

    if (!options.checkOnly) {
      await mkdir(dirname(resolve(options.bindingsOutput)), { recursive: true });
      await writeFile(options.bindingsOutput, `${JSON.stringify(resolved, null, 2)}\n`, 'utf8');
      console.log(`Wrote bindings output: ${options.bindingsOutput}`);
    } else {
      console.log(`Bindings output skipped in --check mode: ${options.bindingsOutput}`);
    }
  }

  return validation;
}

function printBindingErrors(errors: string[]): void {
  if (errors.length === 0) return;

  console.error('Binding map errors:');
  for (const error of errors) {
    console.error(`  ${error}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  const checkOnly = options.checkOnly;

  const definitionFiles = [
    ...(await listDefinitionFiles(join(ontologyRoot, 'EntityTypes'), 'entity', ENTITY_SCHEMA)),
    ...(await listDefinitionFiles(join(ontologyRoot, 'RelationshipTypes'), 'relationship', RELATIONSHIP_SCHEMA)),
  ];

  let converted = 0;
  let keyDateTimesConverted = 0;
  const plannedWrites: PlannedWrite[] = [];
  const unsupported: UnsupportedValueType[] = [];

  for (const definitionFile of definitionFiles) {
    const result = await processDefinitionFile(definitionFile, checkOnly);
    converted += result.converted;
    keyDateTimesConverted += result.keyDateTimesConverted;
    if (result.plannedWrite) plannedWrites.push(result.plannedWrite);
    unsupported.push(...result.unsupported);
  }

  if (!checkOnly && unsupported.length === 0) {
    for (const plannedWrite of plannedWrites) {
      await writeFile(plannedWrite.absolutePath, plannedWrite.content, 'utf8');
    }
  }

  const bindingValidation = await processBindingMap(options, await loadEntityDefinitions());

  console.log(`Files scanned: ${definitionFiles.length}`);
  console.log(`Properties converted: ${converted}${checkOnly ? ' (would convert)' : ''}`);
  console.log(`Entity key DateTime properties converted: ${keyDateTimesConverted}${checkOnly ? ' (would convert)' : ''}`);
  console.log(`Unsupported valueTypes remaining: ${unsupported.length}`);
  console.log(`Kusto source blocks: ${bindingValidation.kustoSourceBlocks}`);
  console.log(`Binding map errors: ${bindingValidation.errors.length}`);
  if (checkOnly) console.log(`Files needing updates: ${plannedWrites.length}`);

  printUnsupported(unsupported);
  printBindingErrors(bindingValidation.errors);

  if (unsupported.length > 0 || bindingValidation.errors.length > 0 || (checkOnly && plannedWrites.length > 0)) {
    process.exitCode = 1;
  }
}

await main();
