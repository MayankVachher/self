// Serves index.html. The web doesn't have to be complicated.
package main

import (
	_ "embed"
	"flag"
	"log"
	"net/http"
)

//go:embed index.html
var index []byte

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	flag.Parse()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
		w.Write(index)
	})

	log.Printf("self serving on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
