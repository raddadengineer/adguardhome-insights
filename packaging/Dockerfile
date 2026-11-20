# Multi-stage Dockerfile preparing upstream AdGuard Home + Insights overlay
# and compiling a minimal non-root Alpine image.

FROM alpine:3.23 AS src

RUN apk --no-cache add git tar

WORKDIR /insights
COPY UPSTREAM_REF ./
COPY overlay ./overlay
COPY patches ./patches
COPY scripts/prepare-src.sh ./scripts/

RUN sh ./scripts/prepare-src.sh --out /src

FROM node:22.14.0-alpine3.21 AS frontend

WORKDIR /src

COPY --from=src /src/client_v2/package.json /src/client_v2/package-lock.json ./client_v2/
RUN npm --prefix client_v2 ci --quiet --no-progress

COPY --from=src /src/client_v2 ./client_v2
RUN npm --prefix client_v2 run build-prod

FROM golang:1.27.4-alpine3.23 AS backend

ARG TARGETOS=linux
ARG TARGETARCH
ARG TARGETVARIANT
ARG VERSION=v1.0.0+insights.docker
ARG CHANNEL=development

WORKDIR /src

COPY --from=src /src/go.mod /src/go.sum ./
RUN go mod download

COPY --from=src /src/main.go /src/main_next.go ./
COPY --from=src /src/internal ./internal
COPY --from=frontend /src/build/static ./build/static

RUN set -eu; \
	goarm=''; \
	case "${TARGETARCH}:${TARGETVARIANT:-}" in \
		arm:v5) goarm='5' ;; \
		arm:v6) goarm='6' ;; \
		arm:v7) goarm='7' ;; \
	esac; \
	ldflags="-s -w -X github.com/AdguardTeam/AdGuardHome/internal/version.version=${VERSION} -X github.com/AdguardTeam/AdGuardHome/internal/version.channel=${CHANNEL}"; \
	CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" GOARM="${goarm}" \
		go build --ldflags="${ldflags}" --trimpath -o /out/AdGuardHome .

FROM alpine:3.23

ARG BUILD_DATE=''
ARG VERSION=v1.0.0+insights.docker
ARG VCS_REF=''

LABEL \
	org.opencontainers.image.created="${BUILD_DATE}" \
	org.opencontainers.image.description="AdGuard Home with Telltale Insights overlay" \
	org.opencontainers.image.licenses="GPL-3.0" \
	org.opencontainers.image.revision="${VCS_REF}" \
	org.opencontainers.image.source="https://github.com/raddadengineer/adguardhome-insights" \
	org.opencontainers.image.title="AdGuard Home Insights" \
	org.opencontainers.image.version="${VERSION}"

RUN apk --no-cache add ca-certificates libcap tzdata && \
	mkdir -p /opt/adguardhome/conf /opt/adguardhome/work && \
	chown -R nobody:nogroup /opt/adguardhome

COPY --from=backend --chmod=0755 --chown=nobody:nogroup /out/AdGuardHome /opt/adguardhome/AdGuardHome

RUN setcap 'cap_net_bind_service=+eip' /opt/adguardhome/AdGuardHome

EXPOSE \
	53/tcp 53/udp \
	67/udp \
	68/udp \
	80/tcp \
	443/tcp 443/udp \
	853/tcp 853/udp \
	3000/tcp 3000/udp \
	5443/tcp 5443/udp

USER nobody:nogroup
WORKDIR /opt/adguardhome/work

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD pidof AdGuardHome >/dev/null || exit 1

ENTRYPOINT ["/opt/adguardhome/AdGuardHome"]
CMD [ \
	"--no-check-update", \
	"-c", "/opt/adguardhome/conf/AdGuardHome.yaml", \
	"-w", "/opt/adguardhome/work" \
]
