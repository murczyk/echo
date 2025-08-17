#!/bin/bash
set -e

CACHE_BASE="/tmp/cache"
CARGO_HOME="$HOME/.cargo"

echo "📊 Cache Status Report"
echo "====================="

# Function to get directory size in MB
get_size_mb() {
    if [ -d "$1" ]; then
        du -sm "$1" 2>/dev/null | cut -f1 || echo "0"
    else
        echo "0"
    fi
}

# Function to get directory size in human readable format
get_size_human() {
    if [ -d "$1" ]; then
        du -sh "$1" 2>/dev/null | cut -f1 || echo "0B"
    else
        echo "0B"
    fi
}

# Function to count files in directory
count_files() {
    if [ -d "$1" ]; then
        find "$1" -type f 2>/dev/null | wc -l || echo "0"
    else
        echo "0"
    fi
}

# Function to show cache age
get_cache_age() {
    if [ -d "$1" ]; then
        newest=$(find "$1" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
        if [ -n "$newest" ] && [ "$newest" != "" ]; then
            age_seconds=$(($(date +%s) - ${newest%.*}))
            if [ $age_seconds -lt 3600 ]; then
                echo "$((age_seconds / 60))m ago"
            elif [ $age_seconds -lt 86400 ]; then
                echo "$((age_seconds / 3600))h ago"
            else
                echo "$((age_seconds / 86400))d ago"
            fi
        else
            echo "unknown"
        fi
    else
        echo "N/A"
    fi
}

echo ""
echo "🌐 Local Disk Caches:"
echo "---------------------"

# NPM Cache
npm_cache="$CACHE_BASE/npm"
if [ -d "$npm_cache" ]; then
    echo "📦 NPM Cache:"
    echo "   Size: $(get_size_human "$npm_cache")"
    echo "   Files: $(count_files "$npm_cache")"
    echo "   Last updated: $(get_cache_age "$npm_cache")"
    if [ -f "$npm_cache/package-lock.json" ]; then
        echo "   Status: ✅ Valid"
    else
        echo "   Status: ⚠️  Incomplete"
    fi
else
    echo "📦 NPM Cache: Not found"
fi

echo ""

# Python Cache
python_cache="$CACHE_BASE/python"
if [ -d "$python_cache" ]; then
    echo "🐍 Python Cache:"
    echo "   Size: $(get_size_human "$python_cache")"
    echo "   Files: $(count_files "$python_cache")"
    echo "   Last updated: $(get_cache_age "$python_cache")"
    if [ -f "$python_cache/requirements.txt" ] && [ -d "$python_cache/.venv" ]; then
        echo "   Status: ✅ Valid"
    else
        echo "   Status: ⚠️  Incomplete"
    fi
else
    echo "🐍 Python Cache: Not found"
fi

echo ""

# Cargo Cache
cargo_cache="$CACHE_BASE/cargo"
if [ -d "$cargo_cache" ]; then
    echo "🦀 Rust Cache (Local):"
    echo "   Total size: $(get_size_human "$cargo_cache")"

    if [ -d "$cargo_cache/registry-index" ]; then
        echo "   Registry index: $(get_size_human "$cargo_cache/registry-index")"
    fi

    if [ -d "$cargo_cache/target" ]; then
        echo "   Build cache: $(get_size_human "$cargo_cache/target")"
    fi

    if [ -d "$cargo_cache/git" ]; then
        echo "   Git deps: $(get_size_human "$cargo_cache/git")"
    fi

    echo "   Last updated: $(get_cache_age "$cargo_cache")"

    if [ -f "$cargo_cache/Cargo.lock" ]; then
        echo "   Status: ✅ Valid"
    else
        echo "   Status: ⚠️  Incomplete"
    fi
else
    echo "🦀 Rust Cache (Local): Not found"
fi

echo ""

# Spacy Cache
spacy_cache="$CACHE_BASE/spacy"
if [ -d "$spacy_cache" ]; then
    echo "🧠 Spacy Cache:"
    echo "   Size: $(get_size_human "$spacy_cache")"
    echo "   Files: $(count_files "$spacy_cache")"
    echo "   Last updated: $(get_cache_age "$spacy_cache")"
    echo "   Status: ✅ Valid"
else
    echo "🧠 Spacy Cache: Not found"
fi

echo ""
echo "🏠 System Caches:"
echo "----------------"

# Cargo System Cache
if [ -d "$CARGO_HOME" ]; then
    echo "🦀 Rust System Cache:"

    if [ -d "$CARGO_HOME/registry" ]; then
        registry_size=$(get_size_mb "$CARGO_HOME/registry")
        echo "   Registry: $(get_size_human "$CARGO_HOME/registry") (${registry_size}MB)"
        if [ $registry_size -gt 500 ]; then
            echo "   ⚠️  Registry cache is large, consider cleanup"
        fi
    fi

    if [ -d "$CARGO_HOME/git" ]; then
        git_size=$(get_size_mb "$CARGO_HOME/git")
        echo "   Git deps: $(get_size_human "$CARGO_HOME/git") (${git_size}MB)"
        if [ $git_size -gt 200 ]; then
            echo "   ⚠️  Git cache is large, consider cleanup"
        fi
    fi
else
    echo "🦀 Rust System Cache: Not found"
fi

# NPM System Cache
if command -v npm &> /dev/null; then
    npm_global_cache=$(npm config get cache 2>/dev/null || echo "")
    if [ -n "$npm_global_cache" ] && [ -d "$npm_global_cache" ]; then
        echo "📦 NPM System Cache: $(get_size_human "$npm_global_cache")"
    fi
fi

echo ""
echo "📈 Summary:"
echo "----------"

total_local=0
cache_dirs=("$CACHE_BASE/npm" "$CACHE_BASE/python" "$CACHE_BASE/cargo" "$CACHE_BASE/spacy")

for dir in "${cache_dirs[@]}"; do
    if [ -d "$dir" ]; then
        size=$(get_size_mb "$dir")
        total_local=$((total_local + size))
    fi
done

echo "Total local cache: ${total_local}MB"

if [ $total_local -gt 1000 ]; then
    echo "⚠️  Local caches are large (>1GB), consider running ./clear-all.sh"
elif [ $total_local -gt 500 ]; then
    echo "💡 Local caches are moderate (>500MB), monitor size"
else
    echo "✅ Local cache sizes are reasonable"
fi

# Check if caches are working
echo ""
echo "🔧 Cache Health:"
echo "---------------"

# Check for cache scripts
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
required_scripts=("restore-npm.sh" "save-npm.sh" "restore-python.sh" "save-python.sh" "restore-cargo.sh" "save-cargo.sh")

all_scripts_present=true
for script in "${required_scripts[@]}"; do
    if [ ! -f "$script_dir/$script" ]; then
        echo "❌ Missing script: $script"
        all_scripts_present=false
    fi
done

if $all_scripts_present; then
    echo "✅ All cache scripts present"
else
    echo "⚠️  Some cache scripts are missing"
fi

# Check script permissions
executable_count=0
for script in "$script_dir"/*.sh; do
    if [ -x "$script" ]; then
        executable_count=$((executable_count + 1))
    fi
done

echo "✅ $executable_count cache scripts are executable"

echo ""
echo "💡 Tips:"
echo "-------"
echo "• Run './clear-all.sh' to clear all caches"
echo "• Run './clear-cargo.sh' for Rust-specific cleanup"
echo "• Large Cargo registry? Install: cargo install cargo-cache"
echo "• Monitor this status before/after CI runs"
