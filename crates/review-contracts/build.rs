use std::{
    env, fs,
    path::{Component, Path, PathBuf},
};

use schemars::schema::RootSchema;
use serde_json::Value;
use typify::{TypeSpace, TypeSpaceSettings};

const SCHEMA_DIR: &str = "packages/review-types/generated/json-schema";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaManifest {
    schemas: Vec<SchemaManifestEntry>,
}

#[derive(Debug, serde::Deserialize)]
struct SchemaManifestEntry {
    name: String,
    file: String,
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("crate must live under <repo>/crates/<crate>");
    let schema_dir = repo_root.join(SCHEMA_DIR);
    let manifest_path = schema_dir.join("manifest.json");

    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest = read_manifest(&manifest_path);
    let mut settings = TypeSpaceSettings::default();
    settings.with_derive("PartialEq".to_owned());
    let mut type_space = TypeSpace::new(&settings);

    for entry in manifest.schemas {
        let schema_path = schema_path(&schema_dir, &entry.file);
        println!("cargo:rerun-if-changed={}", schema_path.display());

        let mut schema_value = read_schema_value(&schema_path);
        let title = upper_camel_case(&entry.name);
        ensure_schema_title(&mut schema_value, &title);
        normalize_schema_for_typify(&mut schema_value, &title);
        let schema = serde_json::from_value::<RootSchema>(schema_value).unwrap_or_else(|error| {
            panic!(
                "failed to parse normalized schema {}: {error}",
                schema_path.display()
            )
        });
        type_space
            .add_root_schema(schema)
            .unwrap_or_else(|error| panic!("failed to typify {}: {error}", schema_path.display()));
    }

    let generated = prettyplease::unparse(
        &syn::parse2::<syn::File>(type_space.to_stream()).expect("typify generated invalid Rust"),
    );

    let output_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("contracts.rs");
    fs::write(output_path, generated).expect("failed to write generated contracts");
}

fn schema_path(schema_dir: &Path, file: &str) -> PathBuf {
    let file_path = Path::new(file);
    let is_single_file = file_path
        .components()
        .all(|component| matches!(component, Component::Normal(_)));

    if !is_single_file || !file.ends_with(".schema.json") {
        panic!("schema manifest entry must be a local *.schema.json file: {file}");
    }

    schema_dir.join(file_path)
}

fn read_manifest(path: &Path) -> SchemaManifest {
    let contents = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&contents)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn read_schema_value(path: &Path) -> Value {
    let contents = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&contents)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn ensure_schema_title(schema: &mut Value, title: &str) {
    let object = schema
        .as_object_mut()
        .expect("review-types schema root must be an object");
    object.insert("title".to_owned(), Value::String(title.to_owned()));
}

fn normalize_schema_for_typify(value: &mut Value, title_hint: &str) {
    match value {
        Value::Object(object) => {
            if matches!(object.get("type").and_then(Value::as_str), Some("object")) {
                object
                    .entry("title")
                    .or_insert_with(|| Value::String(title_hint.to_owned()));
            }

            if object.contains_key("enum") {
                object
                    .entry("title")
                    .or_insert_with(|| Value::String(title_hint.to_owned()));
            }

            if matches!(object.get("type").and_then(Value::as_str), Some("string")) {
                object.remove("minLength");
                object.remove("maxLength");
                object.remove("pattern");
            }

            if matches!(
                object.get("type").and_then(Value::as_str),
                Some("integer" | "number")
            ) {
                object.remove("minimum");
                object.remove("maximum");
                object.remove("exclusiveMinimum");
                object.remove("exclusiveMaximum");
                object.remove("multipleOf");
            }

            if matches!(object.get("type").and_then(Value::as_str), Some("array")) {
                object.remove("minItems");
                object.remove("maxItems");
            }

            if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
                for (property, child) in properties {
                    let property_hint = format!("{title_hint}{}", upper_camel_case(property));
                    normalize_schema_for_typify(child, &property_hint);
                }
            }

            if let Some(items) = object.get_mut("items") {
                normalize_schema_for_typify(items, &format!("{title_hint}Item"));
            }

            for keyword in ["oneOf", "anyOf", "allOf"] {
                if let Some(variants) = object.get_mut(keyword).and_then(Value::as_array_mut) {
                    for (index, child) in variants.iter_mut().enumerate() {
                        let variant_hint = child
                            .get("properties")
                            .and_then(Value::as_object)
                            .and_then(|properties| properties.get("type"))
                            .and_then(|type_schema| type_schema.get("const"))
                            .and_then(Value::as_str)
                            .map(|variant| format!("{title_hint}{}", upper_camel_case(variant)))
                            .unwrap_or_else(|| format!("{title_hint}Variant{}", index + 1));
                        normalize_schema_for_typify(child, &variant_hint);
                    }
                }
            }

            for child in object.values_mut() {
                normalize_schema_for_typify(child, title_hint);
            }
        }
        Value::Array(values) => {
            for child in values {
                normalize_schema_for_typify(child, title_hint);
            }
        }
        _ => {}
    }
}

fn upper_camel_case(value: &str) -> String {
    let mut output = String::new();
    let mut uppercase_next = true;

    for character in value.chars() {
        if !character.is_ascii_alphanumeric() {
            uppercase_next = true;
            continue;
        }

        if uppercase_next {
            output.push(character.to_ascii_uppercase());
            uppercase_next = false;
        } else {
            output.push(character);
        }
    }

    output
}
