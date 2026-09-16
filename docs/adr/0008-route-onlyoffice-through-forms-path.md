---
status: accepted
---

# Route ONLYOFFICE through Forms virtual path

Compose exposes one browser-facing Forms origin. Caddy serves ONLYOFFICE at /office, strips that prefix for the private proxy, and forwards the public host/path and HTTPS scheme so Document Server can operate behind the virtual path. Server document and callback routes remain under /onlyoffice/* and container traffic keeps http://onlyoffice and http://server:3000; standalone Bun development keeps localhost:8080.
