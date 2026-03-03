#!/usr/bin/env bash
# Deploy Marvin to an EKS cluster
#
# Prerequisites:
#   - kubectl configured for your EKS cluster
#   - Docker (for building the image)
#   - An ECR repo or other registry to push to
#   - MCP plugins copied to deploy/plugins/
#   - Placeholders filled in deploy/k8s/ manifests and deploy/oauth2-proxy.cfg
#
# Usage:
#   ./deploy/k8s/deploy.sh                     # Full deploy (build + push + apply)
#   ./deploy/k8s/deploy.sh --apply-only        # Just apply manifests (image already pushed)
#   ./deploy/k8s/deploy.sh --build-only        # Just build and push image
#   ./deploy/k8s/deploy.sh --restart           # Restart the deployment (pick up new image)
#   ./deploy/k8s/deploy.sh --logs              # Tail marvin container logs
#   ./deploy/k8s/deploy.sh --ssh               # Exec into the marvin container

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
NAMESPACE="marvin"

# Container registry — set via env or default to ECR
REGISTRY="${MARVIN_REGISTRY:-}"
IMAGE_NAME="${MARVIN_IMAGE:-marvin}"
IMAGE_TAG="${MARVIN_TAG:-latest}"

if [ -z "$REGISTRY" ]; then
  echo "ERROR: Set MARVIN_REGISTRY env var (e.g., 123456789.dkr.ecr.us-west-2.amazonaws.com)"
  echo "  export MARVIN_REGISTRY=123456789.dkr.ecr.us-west-2.amazonaws.com"
  exit 1
fi

FULL_IMAGE="$REGISTRY/$IMAGE_NAME:$IMAGE_TAG"

# ── Parse args ───────────────────────────────────────────────────────────────
ACTION="full"
for arg in "$@"; do
  case "$arg" in
    --apply-only) ACTION="apply" ;;
    --build-only) ACTION="build" ;;
    --restart)    ACTION="restart" ;;
    --logs)       ACTION="logs" ;;
    --ssh)        ACTION="ssh" ;;
  esac
done

# ── Shortcuts ────────────────────────────────────────────────────────────────
case "$ACTION" in
  logs)
    exec kubectl -n "$NAMESPACE" logs -f deployment/marvin -c marvin
    ;;
  ssh)
    exec kubectl -n "$NAMESPACE" exec -it deployment/marvin -c marvin -- /bin/bash
    ;;
  restart)
    kubectl -n "$NAMESPACE" rollout restart deployment/marvin
    kubectl -n "$NAMESPACE" rollout status deployment/marvin
    exit 0
    ;;
esac

# ── Build & push ─────────────────────────────────────────────────────────────
if [ "$ACTION" = "full" ] || [ "$ACTION" = "build" ]; then
  echo "=== Building image ==="
  docker build -t "$FULL_IMAGE" -f "$PROJECT_DIR/deploy/Dockerfile" "$PROJECT_DIR"

  echo "=== Pushing image ==="
  docker push "$FULL_IMAGE"

  echo "Image: $FULL_IMAGE"

  if [ "$ACTION" = "build" ]; then
    exit 0
  fi
fi

# ── Apply manifests ──────────────────────────────────────────────────────────
echo ""
echo "=== Applying manifests ==="

# Update image in deployment
cd "$SCRIPT_DIR"
kubectl apply -k .

# Set the actual image (kustomization doesn't handle registry)
kubectl -n "$NAMESPACE" set image deployment/marvin marvin="$FULL_IMAGE"

# Wait for rollout
echo ""
echo "=== Waiting for rollout ==="
kubectl -n "$NAMESPACE" rollout status deployment/marvin --timeout=300s

echo ""
echo "=== Deployment complete ==="
echo "  Namespace: $NAMESPACE"
echo "  Image:     $FULL_IMAGE"
echo "  Logs:      ./deploy/k8s/deploy.sh --logs"
echo "  Shell:     ./deploy/k8s/deploy.sh --ssh"
