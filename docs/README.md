# Documentation Index

- [API Overview](./api/overview.md)
- [Authentication & Authorization](./api/auth.md)
- [User Endpoints](./api/users.md)
- [Video Endpoints](./api/videos.md)
- [Search & Discovery](./api/search.md)
- [Favourites & History](./api/history_favorites.md)
- [Settings](./api/settings.md)
- [HLS Streaming Pipeline](./hls_pipeline.md)
- [Using the Website](./using_the_website.md)
- [Security Model](./security.md)

## Architecture Diagram
```mermaid
flowchart TD
	subgraph Client
		UI[Web UI / Player]
	end
	subgraph Backend[Flask API]
		R[Routes & Blueprints]
		A[Auth & JWT]
		V[Video Module]
		U[User Module]
		L[Rate Limiter]
		W[Worker Thread]
	end
	subgraph Storage
		DB[(SQL Database)]
		FS[(Filesystem HLS + Thumbnails)]
		Redis[(Redis Optional)]
	end

	UI -->|HTTPS JSON / HLS| R
	R --> A
	R --> V
	R --> U
	A --> DB
	V --> DB
	U --> DB
	L --> R
	R --> L
	W --> DB
	W --> FS
	V --> FS
	L --> Redis
```
