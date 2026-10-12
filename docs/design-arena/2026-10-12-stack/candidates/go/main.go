package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func stdout() *os.File { return os.Stdout }

func main() {
	if err := entry(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func entry(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(args) != 0 && args[0] == "bench" {
		return benchMain(ctx, args[1:])
	}
	if len(args) != 0 && args[0] == "driver-probe" {
		return driverProbe(ctx, args[1:])
	}
	mode := os.Getenv("CASEBOOK_MODE")
	if mode == "" {
		mode = "embedded"
	}
	path := os.Getenv("CASEBOOK_DB")
	if path == "" {
		path = "work.db"
	}
	if len(args) == 0 || args[0] == "--help" || (len(args) > 1 && args[1] == "--help") {
		return NewRegistry(&Service{}).CLI(ctx, args)
	}
	if args[0] == "openapi" {
		return json.NewEncoder(os.Stdout).Encode(NewRegistry(&Service{}).OpenAPI())
	}
	var addr string
	if args[0] == "serve" {
		fs := flag.NewFlagSet("serve", flag.ContinueOnError)
		fs.StringVar(&mode, "mode", mode, "embedded or server")
		fs.StringVar(&path, "db", path, "SQLite file")
		fs.StringVar(&addr, "addr", "127.0.0.1:0", "HTTP listener")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
	}
	store, err := OpenStore(ctx, mode, path)
	if err != nil {
		return err
	}
	defer store.Close()
	service := &Service{store}
	registry := NewRegistry(service)
	switch args[0] {
	case "mcp":
		return registry.MCP().Run(ctx, &mcp.StdioTransport{})
	case "serve":
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			return err
		}
		server := &http.Server{Handler: registry.Handler(service), ReadHeaderTimeout: 5 * time.Second}
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"listen": "http://" + listener.Addr().String(), "pid": os.Getpid(), "driver": sqliteFlavor}); err != nil {
			listener.Close()
			return err
		}
		go func() {
			<-ctx.Done()
			shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = server.Shutdown(shut)
		}()
		err = server.Serve(listener)
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case "selfcheck":
		return SelfCheck(ctx, service)
	case "diagnose":
		return Diagnose(ctx, service)
	default:
		return registry.CLI(ctx, args)
	}
}
