use crate::{db::Db, ops::*};
use anyhow::{Result, bail};
use serde_json::{Value, json};

pub struct Operation {
    pub name: &'static str,
    pub description: &'static str,
    pub write: bool,
    pub input: Value,
    pub output: Value,
}
macro_rules! registry {
    ($( $name:ident : $input:ty => $output:ty, $handler:ident, $description:literal, $write:literal; )*) => {
        pub fn operations()-> &'static [Operation] { static OPS:std::sync::OnceLock<Vec<Operation>>=std::sync::OnceLock::new(); OPS.get_or_init(||vec![$(Operation {name:stringify!($name),description:$description,write:$write,input:serde_json::to_value(schemars::schema_for!($input)).unwrap(),output:serde_json::to_value(schemars::schema_for!($output)).unwrap()}),*]) }
        pub async fn dispatch(db:&mut Db,name:&str,raw:Value)->Result<Value> { match name { $(stringify!($name)=>{
            let out=$handler(db,serde_json::from_value::<$input>(raw)?).await?;
            Ok(serde_json::to_value(serde_json::from_value::<$output>(out)?)?)
        },)* _=>bail!("Unknown operation {name}") } }
    }
}
registry! {
    get: GetIn => GetOut, get, "Read a case with its current version.", false;
    propose: ProposeIn => ProposeOut, propose, "Seal a case version atomically. Replay cmd to obtain its original receipt.", true;
    report: ReportIn => ReportOut, report, "Ingest a normalized result batch atomically. A repeated batch key writes nothing.", true;
}
fn refs(v: &mut Value) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                if k == "$ref" {
                    if let Some(r) = x.as_str() {
                        if r.starts_with("#/$defs/") {
                            *x = json!(r.replace("#/$defs/", "#/components/schemas/"));
                        }
                    }
                } else {
                    refs(x)
                }
            }
        }
        Value::Array(a) => {
            for x in a {
                refs(x)
            }
        }
        _ => {}
    }
}
pub fn openapi() -> Value {
    let mut schemas = serde_json::Map::new();
    let mut paths = serde_json::Map::new();
    for op in operations() {
        for (suffix, mut schema) in [("input", op.input.clone()), ("output", op.output.clone())] {
            refs(&mut schema);
            if let Some(defs) = schema.as_object_mut().unwrap().remove("$defs") {
                for (k, v) in defs.as_object().unwrap() {
                    schemas.insert(k.clone(), v.clone());
                }
            }
            schemas.insert(format!("{}_{}", op.name, suffix), schema);
        }
        paths.insert(format!("/op/{}",op.name),json!({"post":{"operationId":op.name,"description":op.description,"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":format!("#/components/schemas/{}_input",op.name)}}}},"responses":{"200":{"description":"Operation result","content":{"application/json":{"schema":{"$ref":format!("#/components/schemas/{}_output",op.name)}}}},"400":{"description":"Invalid input"}}}}));
    }
    json!({"openapi":"3.1.0","info":{"title":"Mainworthy Rust arena","version":"0.1.0"},"paths":paths,"components":{"schemas":schemas}})
}
pub fn tools() -> Vec<rmcp::model::Tool> {
    operations().into_iter().map(|op|serde_json::from_value(json!({"name":op.name,"description":op.description,"inputSchema":op.input,"outputSchema":op.output,"annotations":{"readOnlyHint":!op.write,"destructiveHint":false,"idempotentHint":true}})).unwrap()).collect()
}
pub fn help(name: Option<&str>) -> String {
    let mut out = String::from(
        "Mainworthy Rust arena\nUsage: mainworthy-rust-spike <operation> [JSON input]\nConfigure CB_MODE=embedded|server and CB_DB=<file|connection string>.\nOther commands: serve <mode> <db> <port>, mcp <mode> <db>, openapi\n",
    );
    for op in operations() {
        if name.is_none() || name == Some(op.name) {
            out.push_str(&format!(
                "\n{}: {}\nInput: {}\nOutput: {}\n",
                op.name, op.description, op.input, op.output
            ));
        }
    }
    out
}
