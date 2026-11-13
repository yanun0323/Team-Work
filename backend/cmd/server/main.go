// Command server is the Team Work backend.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/yanun0323/Team-Work/config"
	"github.com/yanun0323/Team-Work/internal/delivery"
	"github.com/yanun0323/Team-Work/internal/providers"
	"github.com/yanun0323/Team-Work/internal/providers/claude"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/semantic"
	"github.com/yanun0323/Team-Work/internal/tower"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "server:", err)
		os.Exit(1)
	}
}

func run() error {
	desktop := flag.Bool("desktop", false, "run as a child of the macOS app; stop when stdin closes")
	webDir := flag.String("web-dir", "", "serve the built frontend from this directory")
	flag.Parse()
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.Debug {
		zerolog.SetGlobalLevel(zerolog.DebugLevel)
	} else {
		zerolog.SetGlobalLevel(zerolog.InfoLevel)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *desktop {
		// The app owns this pipe. EOF also stops us if the app crashes or is killed.
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}

	// Team Work signs in to Claude Code and keeps its conversations in a folder of its own, apart from ~/.claude
	if err := claude.UseConfigDir(filepath.Join(cfg.DataDir, "claude")); err != nil {
		return err
	}
	store, err := repository.NewStore(cfg.DataDir)
	if err != nil {
		return err
	}
	defer store.Close()
	// Experimental semantic search: off unless the saved setting turns it on, and only on macOS 27 on Apple silicon.
	// TEAM_WORK_SEMANTIC_HELPER points at a semantic-helper built outside the app, for development.
	semanticSearch := semantic.New(semantic.Options{DataDir: cfg.DataDir, Log: log.Logger, Platform: semantic.Detect(os.Getenv("TEAM_WORK_SEMANTIC_HELPER"))})
	defer semanticSearch.Close()
	factory := providers.NewFactory(store, slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	defer factory.Close()
	engine, err := usecase.NewEngine(ctx, usecase.Options{
		Store: store, Git: repository.NewGit(cfg.DataDir), Providers: factory, DataDir: cfg.DataDir, Log: log.Logger, Semantic: semanticSearch,
	})
	if err != nil {
		return err
	}
	// runs stop first, so nothing is saved to a closing database
	defer engine.Close()
	engine.StartSemantic()
	// a provider may have put out models since the last run
	engine.RefreshStaleModels(0)
	// a repo a blueprint names is kept as a source with no version until it is first read, and the official source
	// starts on the copy built in until its newest version is found
	go func() {
		if err := engine.PinSources(ctx); err != nil {
			log.Warn().Err(err).Msg("pin sources")
		}
		if err := engine.CheckSource(ctx, usecase.OfficialSourceID); err != nil {
			log.Warn().Err(err).Msg("check the official source")
		}
	}()

	l, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return err
	}
	defer l.Close()
	server := delivery.NewServer(engine, factory.ClaudeCode(), repository.FolderPicker{}, repository.Terminals{}, cfg.AllowedOrigins, log.Logger)
	towers, err := tower.New(ctx, cfg.DataDir, tower.Tailcat{})
	if err != nil {
		return err
	}
	defer towers.Close()
	server.EnableTowers(towers)
	if cfg.MemoryDiagnostics {
		server.EnableMemoryDiagnostics()
	}
	if *webDir != "" {
		if _, err := os.Stat(*webDir + "/index.html"); err != nil {
			return fmt.Errorf("frontend: %w", err)
		}
		server.Frontend(os.DirFS(*webDir))
	}
	log.Info().Str("addr", l.Addr().String()).Str("data", cfg.DataDir).Msg("listening")
	if *desktop {
		fmt.Fprintln(os.Stdout, "READY")
	}
	return server.Serve(ctx, l)
}
