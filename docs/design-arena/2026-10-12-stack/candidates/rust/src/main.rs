mod db;
mod ops;
mod registry;
use anyhow::{Context, Result, ensure};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use ops::Store;
use rmcp::{RoleServer, ServerHandler, ServiceExt, model::*, service::RequestContext};
use serde_json::{Value, json};
use std::{io::Read, time::Instant};

fn response(result: Result<(Value, f64)>) -> Response {
    match result {
        Ok((v, ms)) => ([("X-Store-Ms", format!("{ms:.6}"))], Json(v)).into_response(),
        Err(e) => {
            eprintln!("request: {e:#}");
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":format!("{e:#}")})),
            )
                .into_response()
        }
    }
}
async fn op_http(
    State(store): State<Store>,
    Extension(name): Extension<String>,
    Json(input): Json<Value>,
) -> Response {
    response(store.call(&name, input).await)
}
async fn bench_http(
    State(store): State<Store>,
    Path(name): Path<String>,
    Json(input): Json<Value>,
) -> Response {
    response(store.call(&name, input).await)
}
async fn parse_http(body: Bytes) -> Response {
    let t = Instant::now();
    let result = (|| {
        let rows = ops::parse_junit(std::str::from_utf8(&body)?)?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        Ok((
            json!({"count":rows.len(),"failures":rows.iter().filter(|r|r.outcome=="fail").count(),"parse_ms":ms,"message_bytes":rows.iter().filter_map(|r|r.message.as_ref()).map(|s|s.len()).sum::<usize>(),"keys_nonempty":rows.iter().all(|r|!r.key.is_empty())}),
            ms,
        ))
    })();
    response(result)
}
async fn serve(store: Store, port: u16) -> Result<()> {
    let mut router = Router::<Store>::new()
        .route("/health", get(|| async { Json(json!({"ok":true})) }))
        .route("/openapi.json", get(|| async { Json(registry::openapi()) }))
        .route("/bench/{name}", post(bench_http))
        .route("/parse", post(parse_http));
    for op in registry::operations() {
        router = router.route(
            &format!("/op/{}", op.name),
            post(op_http).layer(Extension(op.name.to_owned())),
        );
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("listening {}", listener.local_addr()?);
    axum::serve(
        listener,
        router
            .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
            .with_state(store),
    )
    .await?;
    Ok(())
}
#[derive(Clone)]
struct Mcp(Store);
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, rmcp::ErrorData> {
        Ok(serde_json::from_value(json!({"tools":registry::tools()})).unwrap())
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        registry::tools().into_iter().find(|t| t.name == name)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, rmcp::ErrorData> {
        let name = request.name.as_ref();
        if !registry::operations().iter().any(|s| s.name == name) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "Unknown registered operation",
            )])
            .into());
        }
        let raw = Value::Object(request.arguments.unwrap_or_default());
        let result = self.0.call(name, raw).await;
        let out = match result {
            Ok((v, _)) => {
                let mut r = CallToolResult::success(vec![ContentBlock::text(v.to_string())]);
                r.structured_content = Some(v);
                r
            }
            Err(e) => CallToolResult::error(vec![ContentBlock::text(format!("{e:#}"))]),
        };
        Ok(out.into())
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 8)]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args[0] == "help" || args[0] == "--help" {
        print!("{}", registry::help(None));
        return Ok(());
    }
    if args[0] == "openapi" {
        println!("{}", registry::openapi());
        return Ok(());
    }
    if args.len() > 1 && args[1] == "--help" {
        print!("{}", registry::help(Some(&args[0])));
        return Ok(());
    }
    if args[0] == "serve" || args[0] == "mcp" {
        let mode = args.get(1).context("mode required")?;
        let path = args.get(2).context("db required")?;
        let store = Store::open(mode, path).await?;
        if args[0] == "serve" {
            serve(store, args.get(3).context("port required")?.parse()?).await?;
        } else {
            let service = Mcp(store).serve(rmcp::transport::stdio()).await?;
            service.waiting().await?;
        }
        return Ok(());
    }
    ensure!(
        registry::operations().iter().any(|s| s.name == args[0]),
        "Unknown registered operation"
    );
    let mode = std::env::var("CB_MODE").unwrap_or_else(|_| "embedded".into());
    let path = std::env::var("CB_DB").unwrap_or_else(|_| "work.db".into());
    let raw = if let Some(v) = args.get(1) {
        v.clone()
    } else {
        let mut v = String::new();
        std::io::stdin().read_to_string(&mut v)?;
        v
    };
    let input = serde_json::from_str(&raw)?;
    let (out, _) = Store::open(&mode, &path)
        .await?
        .call(&args[0], input)
        .await?;
    println!("{}", out);
    Ok(())
}
