package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Operation struct {
	Name, Description string
	ReadOnly          bool
	Input, Output     *jsonschema.Schema
	InputType         reflect.Type
	Invoke            func(context.Context, json.RawMessage) (any, error)
	AddMCP            func(*mcp.Server)
}
type Registry struct{ Operations []*Operation }
type operationTimingKey struct{}

func addOperation[I, O any](registry *Registry, name, description string, readOnly bool, invoke func(context.Context, I) (O, error)) {
	input, err := jsonschema.For[I](nil)
	if err != nil {
		panic(err)
	}
	output, err := jsonschema.For[O](nil)
	if err != nil {
		panic(err)
	}
	resolved, err := input.Resolve(nil)
	if err != nil {
		panic(err)
	}
	op := &Operation{Name: name, Description: description, ReadOnly: readOnly, Input: input, Output: output, InputType: reflect.TypeFor[I]()}
	op.Invoke = func(ctx context.Context, raw json.RawMessage) (any, error) {
		var obj any
		if err := json.Unmarshal(raw, &obj); err != nil {
			return nil, err
		}
		if err := resolved.Validate(obj); err != nil {
			return nil, fmt.Errorf("invalid input: %w", err)
		}
		var in I
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&in); err != nil {
			return nil, err
		}
		start := time.Now()
		out, err := invoke(ctx, in)
		if elapsed, ok := ctx.Value(operationTimingKey{}).(*time.Duration); ok {
			*elapsed = time.Since(start)
		}
		return out, err
	}
	op.AddMCP = func(server *mcp.Server) {
		no := false
		tool := &mcp.Tool{Name: name, Description: description, InputSchema: input, OutputSchema: output,
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: readOnly, IdempotentHint: true, DestructiveHint: &no}}
		mcp.AddTool(server, tool, func(ctx context.Context, _ *mcp.CallToolRequest, in I) (*mcp.CallToolResult, O, error) {
			out, err := invoke(ctx, in)
			return nil, out, err
		})
	}
	registry.Operations = append(registry.Operations, op)
}

func NewRegistry(service *Service) *Registry {
	r := &Registry{}
	addOperation(r, "get", "Read a project 1 case and its head version.", true, service.Get)
	addOperation(r, "propose", "Seal and adopt a case using a command ID and expected base version.", false, service.Save)
	addOperation(r, "report", "Atomically ingest normalized results; replaying a batch key writes nothing.", false, service.Report)
	return r
}

func (r *Registry) OpenAPI() map[string]any {
	paths := map[string]any{}
	for _, op := range r.Operations {
		paths["/ops/"+op.Name] = map[string]any{"post": map[string]any{
			"operationId": op.Name, "description": op.Description,
			"requestBody": map[string]any{"required": true, "content": map[string]any{"application/json": map[string]any{"schema": op.Input}}},
			"responses":   map[string]any{"200": map[string]any{"description": "Operation outcome", "content": map[string]any{"application/json": map[string]any{"schema": op.Output}}}},
		}}
	}
	return map[string]any{"openapi": "3.1.0", "jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema", "info": map[string]any{"title": "Mainworthy Go arena", "version": "1.0.0"}, "paths": paths}
}

func jsonResponse(w http.ResponseWriter, out any, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		status := http.StatusBadRequest
		if strings.HasPrefix(err.Error(), "conflict:") {
			status = http.StatusConflict
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	if err := json.NewEncoder(w).Encode(out); err != nil {
		return
	}
}

func workloadHandler[I, O any](invoke func(context.Context, I) (O, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var in I
		err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 8<<20)).Decode(&in)
		if err != nil {
			jsonResponse(w, nil, err)
			return
		}
		start := time.Now()
		out, err := invoke(req.Context(), in)
		w.Header().Set("X-Operation-Ms", strconv.FormatFloat(float64(time.Since(start))/float64(time.Millisecond), 'f', 6, 64))
		jsonResponse(w, out, err)
	}
}

func (r *Registry) Handler(service *Service) http.Handler {
	mux := http.NewServeMux()
	for _, op := range r.Operations {
		mux.HandleFunc("POST /ops/"+op.Name, func(w http.ResponseWriter, req *http.Request) {
			raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, 8<<20))
			if err != nil {
				jsonResponse(w, nil, err)
				return
			}
			var elapsed time.Duration
			out, err := op.Invoke(context.WithValue(req.Context(), operationTimingKey{}, &elapsed), raw)
			w.Header().Set("X-Operation-Ms", strconv.FormatFloat(float64(elapsed)/float64(time.Millisecond), 'f', 6, 64))
			jsonResponse(w, out, err)
		})
	}
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, req *http.Request) { jsonResponse(w, r.OpenAPI(), nil) })
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, req *http.Request) {
		jsonResponse(w, map[string]string{"status": "ok", "driver": sqliteFlavor}, nil)
	})
	mux.HandleFunc("POST /work/W2", workloadHandler(service.List))
	mux.HandleFunc("POST /work/W3", workloadHandler(service.Search))
	mux.HandleFunc("POST /work/W6", workloadHandler(service.Recent))
	mux.HandleFunc("POST /work/W7", workloadHandler(service.Gate))
	mux.HandleFunc("POST /work/W8", workloadHandler(service.Queue))
	return mux
}

func (r *Registry) MCP() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "mainworthy-go", Version: "1.0.0"}, nil)
	for _, op := range r.Operations {
		op.AddMCP(server)
	}
	return server
}

func (r *Registry) CLI(ctx context.Context, args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		fmt.Println("Usage: mainworthy <operation> [--input JSON | generated flags]")
		for _, op := range r.Operations {
			fmt.Printf("  %-10s %s\n", op.Name, op.Description)
		}
		return nil
	}
	for _, op := range r.Operations {
		if op.Name != args[0] {
			continue
		}
		fs := flag.NewFlagSet(op.Name, flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		raw := fs.String("input", "", "Complete input as JSON")
		fields := map[string]*string{}
		for i := 0; i < op.InputType.NumField(); i++ {
			field := op.InputType.Field(i)
			name := strings.Split(field.Tag.Get("json"), ",")[0]
			desc := field.Tag.Get("jsonschema")
			if desc == "" {
				desc = field.Type.String()
			}
			fields[name] = fs.String(name, "", desc)
		}
		fs.Usage = func() {
			fmt.Printf("Usage: mainworthy %s [flags]\n%s\n", op.Name, op.Description)
			fs.SetOutput(io.Discard)
			fs.VisitAll(func(f *flag.Flag) { fmt.Printf("  --%-12s %s\n", f.Name, f.Usage) })
		}
		if err := fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if *raw == "" {
			input := map[string]any{}
			for i := 0; i < op.InputType.NumField(); i++ {
				field := op.InputType.Field(i)
				name := strings.Split(field.Tag.Get("json"), ",")[0]
				value := *fields[name]
				if value == "" {
					continue
				}
				switch field.Type.Kind() {
				case reflect.String:
					input[name] = value
				case reflect.Int64, reflect.Int, reflect.Int32:
					n, err := strconv.ParseInt(value, 10, 64)
					if err != nil {
						return err
					}
					input[name] = n
				default:
					var obj any
					if err := json.Unmarshal([]byte(value), &obj); err != nil {
						return err
					}
					input[name] = obj
				}
			}
			encoded, err := json.Marshal(input)
			if err != nil {
				return err
			}
			*raw = string(encoded)
		}
		out, err := op.Invoke(ctx, json.RawMessage(*raw))
		if err != nil {
			return err
		}
		return json.NewEncoder(io.Writer(stdout())).Encode(out)
	}
	return fmt.Errorf("unknown operation %q", args[0])
}
