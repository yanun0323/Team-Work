// Command server is the Mho Company backend.
package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/yanun0323/mho-company/config"
	"github.com/yanun0323/mho-company/internal/delivery"
	"github.com/yanun0323/mho-company/internal/providers"
	"github.com/yanun0323/mho-company/internal/repository"
	"github.com/yanun0323/mho-company/internal/usecase"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "server:", err)
		os.Exit(1)
	}
}

func run() error {
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

	store, err := repository.NewStore(cfg.DataDir)
	if err != nil {
		return err
	}
	defer store.Close()
	factory := providers.NewFactory(store)
	defer factory.Close()
	engine, err := usecase.NewEngine(ctx, usecase.Options{
		Store: store, Git: repository.NewGit(cfg.DataDir), Providers: factory, DataDir: cfg.DataDir, Log: log.Logger,
	})
	if err != nil {
		return err
	}
	// runs stop first, so nothing is saved to a closing database
	defer engine.Close()

	l, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return err
	}
	log.Info().Str("addr", l.Addr().String()).Str("data", cfg.DataDir).Msg("listening")
	return delivery.NewServer(engine, factory.ClaudeCode(), cfg.AllowedOrigins, log.Logger).Serve(ctx, l)
}
