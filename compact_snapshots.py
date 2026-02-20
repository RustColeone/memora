#!/usr/bin/env python3
"""
Snapshot Compaction Script
Run this periodically (e.g., nightly cron job) to compact old operations into snapshots
This keeps the operation log size manageable
"""

import requests
import sys

# Server configuration
SERVER_URL = "http://localhost:5050"  # Change to your server URL
VARIANTS = ['default', 'finance']
KEEP_DAYS = 30  # Keep operations from last 30 days

def compact_variant(variant, keep_days=30):
    """Compact operations for a specific variant"""
    print(f"\n📦 Compacting {variant} variant...")
    print(f"   Keeping operations from last {keep_days} days")
    
    url = f"{SERVER_URL}/api/operations/compact?variant={variant}"
    
    try:
        response = requests.post(url, json={'keepDays': keep_days})
        
        if response.status_code == 200:
            result = response.json()
            if result.get('success'):
                print(f"   ✅ Success!")
                print(f"      Compacted: {result.get('compactedCount', 0)} operations")
                print(f"      Snapshot ID: {result.get('snapshotId', 0)}")
                print(f"      Remaining operations: {result.get('remainingOps', 0)}")
                return True
            else:
                print(f"   ❌ Failed: {result.get('message', 'Unknown error')}")
                return False
        else:
            print(f"   ❌ HTTP Error {response.status_code}: {response.text}")
            return False
            
    except requests.exceptions.ConnectionError:
        print(f"   ❌ Connection Error: Could not connect to {SERVER_URL}")
        print(f"      Make sure the server is running!")
        return False
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def main():
    print("=" * 60)
    print("Snapshot Compaction Script")
    print("=" * 60)
    print(f"\nServer: {SERVER_URL}")
    print(f"Variants: {', '.join(VARIANTS)}")
    print(f"Retention: {KEEP_DAYS} days")
    print("=" * 60)
    
    success_count = 0
    
    for variant in VARIANTS:
        if compact_variant(variant, KEEP_DAYS):
            success_count += 1
    
    print("\n" + "=" * 60)
    if success_count == len(VARIANTS):
        print("✅ All variants compacted successfully!")
    elif success_count > 0:
        print(f"⚠️  Partial success: {success_count}/{len(VARIANTS)} variants compacted")
    else:
        print("❌ Compaction failed for all variants")
    print("=" * 60)
    print()
    
    sys.exit(0 if success_count == len(VARIANTS) else 1)

if __name__ == '__main__':
    main()
