package main

import (
	"log"
	"net/http"
	"os"
	"strconv"

	"go-proxy/internal/config"
	routes "go-proxy/internal/http"
)

func main() {
	args := os.Args[1:]
	cfg, err := config.LoadFromArgs(args)
	if err != nil {
		log.Fatalf("config load failed: %v", err)
	}
	addr := cfg.Host + ":" + strconv.Itoa(cfg.Port)

	log.Printf("go-proxy listening on %s", addr)
	if err := http.ListenAndServe(addr, routes.NewRoutes(cfg)); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
