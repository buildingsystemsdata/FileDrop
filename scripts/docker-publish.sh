#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

DOCKER_IMAGE_REPO="${DOCKER_IMAGE_REPO:-}"
DOCKER_IMAGE_TAG="${DOCKER_IMAGE_TAG:-latest}"
DOCKER_PLATFORMS="${DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"
BUILDX_BUILDER="${BUILDX_BUILDER:-multiarch-builder}"
PUBLISH_LATEST="${PUBLISH_LATEST:-true}"

if [[ -z "${DOCKER_IMAGE_REPO}" || "${DOCKER_IMAGE_REPO}" == "your-dockerhub-username/file-upload" ]]; then
  echo "Set DOCKER_IMAGE_REPO in .env to your Docker Hub repository, for example: your-user/file-upload" >&2
  exit 1
fi

if [[ -n "${DOCKERHUB_USERNAME:-}" && -n "${DOCKERHUB_TOKEN:-}" ]]; then
  echo "${DOCKERHUB_TOKEN}" | docker login --username "${DOCKERHUB_USERNAME}" --password-stdin
else
  echo "DOCKERHUB_USERNAME/DOCKERHUB_TOKEN not set; using existing docker login if available."
fi

docker buildx inspect "${BUILDX_BUILDER}" --bootstrap >/dev/null
docker buildx use "${BUILDX_BUILDER}"

TAGS=(-t "${DOCKER_IMAGE_REPO}:${DOCKER_IMAGE_TAG}")
if [[ "${PUBLISH_LATEST}" == "true" && "${DOCKER_IMAGE_TAG}" != "latest" ]]; then
  TAGS+=(-t "${DOCKER_IMAGE_REPO}:latest")
fi

docker buildx build \
  --platform "${DOCKER_PLATFORMS}" \
  "${TAGS[@]}" \
  --push \
  "${ROOT_DIR}"
