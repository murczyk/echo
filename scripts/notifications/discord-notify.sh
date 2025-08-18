#!/usr/bin/env bash

# Discord Notification Script for GitHub Actions
# Usage: ./discord-notify.sh <type> <status> [title] [description]

set -Eeuo pipefail

# Configuration: read from env or optional config.env; never hardcode secrets
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer CI-specific var; fall back to local config if neither is set
if [[ -z "${DISCORD_WEBHOOK_URL_CI:-}" && -z "${DISCORD_WEBHOOK_URL:-}" && -f "$SCRIPT_DIR/config.env" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/config.env"
fi

WEBHOOK_URL="${DISCORD_WEBHOOK_URL_CI:-${DISCORD_WEBHOOK_URL:-${WEBHOOK_URL:-}}}"
if [[ -z "${WEBHOOK_URL:-}" ]]; then
  echo "ERROR: Discord webhook URL is not set. Configure GitHub secret 'DISCORD_WEBHOOK_URL_CI' (preferred for CI) or set 'DISCORD_WEBHOOK_URL' in scripts/notifications/config.env for local/dev." >&2
  exit 2
fi

# Colors
declare -A COLORS=(
    ["success"]="65280"      # Green
    ["failure"]="16711680"   # Red
    ["warning"]="16776960"   # Yellow
    ["info"]="8421504"       # Gray
    ["critical"]="16711680"  # Red
)

# Emojis
declare -A EMOJIS=(
    ["success"]="✅"
    ["failure"]="❌"
    ["warning"]="⚠️"
    ["info"]="ℹ️"
    ["critical"]="🚨"
    ["security"]="🔒"
    ["release"]="🚀"
    ["deployment"]="🚀"
    ["bug"]="🐛"
    ["cancelled"]="⏹️"
    ["tests"]="🧪"
    ["pr"]="📋"
)

# Type-specific configurations
declare -A TYPE_CONFIG=(
    ["ci_success"]="success,tests,CI Tests Passed"
    ["ci_failure"]="failure,tests,CI Tests Failed"
    ["ci_cancelled"]="warning,cancelled,CI Tests Cancelled"
    ["pr_check_success"]="success,pr,PR Checkboxes Valid"
    ["pr_check_failure"]="failure,pr,PR Checkboxes Invalid"
    ["release_published"]="success,release,Release Published"
    ["release_prerelease"]="warning,release,Pre-release Published"
    ["deployment_success"]="success,deployment,Deployment Successful"
    ["deployment_failure"]="failure,deployment,Deployment Failed"
    ["security_advisory"]="critical,security,Security Advisory"
    ["vulnerability_alert"]="critical,security,Vulnerability Alert"
    ["critical_issue"]="critical,bug,Critical Issue"
    ["dependency_update"]="info,info,Dependencies Updated"
)

# Functions
json_escape() {
    # Escapes a string for safe embedding in JSON
    local s=${1:-}
    s=${s//\/\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/\\r}
    s=${s//$'\t'/\\t}
    echo "$s"
}

get_color() {
    local status=$1
    echo "${COLORS[$status]:-${COLORS[info]}}"
}

get_emoji() {
    local emoji_type=$1
    echo "${EMOJIS[$emoji_type]:-${EMOJIS[info]}}"
}

build_description() {
    local base_desc="$1"
    local include_commit=${2:-true}

    if [ "$include_commit" = "true" ]; then
        base_desc="$base_desc\n\nRepository: \`${GITHUB_REPOSITORY:-unknown}\`"
        base_desc="$base_desc\nBranch: \`${GITHUB_REF_NAME:-unknown}\`"
        base_desc="$base_desc\nCommit: \`${GITHUB_SHA:-unknown}\`"
        if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
          base_desc="$base_desc\n\n[View Run](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID})"
        fi
    fi

    echo "$base_desc"
}

send_notification() {
    local title="$1"
    local description="$2"
    local color="$3"
    local footer="${4:-GitHub Actions}"

    local esc_title; esc_title=$(json_escape "$title")
    local esc_desc; esc_desc=$(json_escape "$description")
    local esc_footer; esc_footer=$(json_escape "$footer")

    curl -fsS -H "Content-Type: application/json" \
        -d "{\"embeds\":[{\"title\":\"${esc_title}\",\"description\":\"${esc_desc}\",\"color\":${color},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"footer\":{\"text\":\"${esc_footer}\"}}]}" \
        "$WEBHOOK_URL"
}

# Main function
main() {
    local notification_type="$1"
    local custom_status="$2"
    local custom_title="$3"
    local custom_description="$4"
    local include_commit="${5:-true}"

    if [ -z "$notification_type" ]; then
        echo "Usage: $0 <type> [status] [title] [description] [include_commit]"
        echo "Types: ci_success, ci_failure, pr_check_success, release_published, etc."
        exit 1
    fi

    # Get configuration for the notification type
    local config="${TYPE_CONFIG[$notification_type]}"
    if [ -n "$config" ]; then
        IFS=',' read -r status emoji_type default_title <<< "$config"
    else
        # Fallback for custom types
        status="${custom_status:-info}"
        emoji_type="${custom_status:-info}"
        default_title="Notification"
    fi

    # Use custom values if provided, otherwise use defaults
    local final_status="${custom_status:-$status}"
    local final_title="${custom_title:-$default_title}"
    local final_description="${custom_description:-No description provided.}"

    # Get color and emoji
    local color=$(get_color "$final_status")
    local emoji=$(get_emoji "$emoji_type")

    # Build final title and description
    local full_title="$emoji $final_title"
    local full_description=$(build_description "$final_description" "$include_commit")

    # Send notification
    send_notification "$full_title" "$full_description" "$color"

    echo "Discord notification sent: $notification_type"
}

# Execute main function with all arguments
main "$@"
