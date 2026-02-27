#!/bin/bash
# Comprehensive model switch testing script
# Tests multiple sequential model switches to verify retry logic

API_BASE="${CLAWBOARD_API_BASE:-http://localhost:3001/api}"
TOKEN="${CLAWBOARD_TOKEN:-your-jwt-token-here}"

echo "🧪 Testing Model Switch Retry Logic"
echo "===================================="
echo ""

# Get current model
echo "📊 Getting current model..."
CURRENT=$(curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE/models/status" | jq -r '.activeModel')
echo "   Current model: $CURRENT"
echo ""

# Test sequence: Switch through 3 different models
MODELS=(
  "anthropic/claude-sonnet-4-5"
  "litellm/phi4"
  "anthropic/claude-opus-4-5"
)

SUCCESS=0
FAILED=0

for i in "${!MODELS[@]}"; do
  MODEL="${MODELS[$i]}"
  echo "🔄 Test $((i+1))/3: Switching to $MODEL..."
  
  START=$(date +%s%3N)
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\"}" \
    "$API_BASE/models/switch")
  
  HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
  BODY=$(echo "$RESPONSE" | head -n -1)
  END=$(date +%s%3N)
  DURATION=$((END - START))
  
  if [ "$HTTP_CODE" = "200" ]; then
    echo "   ✅ SUCCESS (${DURATION}ms)"
    echo "   Response: $BODY"
    ((SUCCESS++))
  else
    echo "   ❌ FAILED (HTTP $HTTP_CODE)"
    echo "   Response: $BODY"
    ((FAILED++))
  fi
  
  echo ""
  
  # Wait 3 seconds between switches to allow full reconnection
  if [ $i -lt $((${#MODELS[@]} - 1)) ]; then
    echo "   ⏱  Waiting 3s before next switch..."
    sleep 3
    echo ""
  fi
done

echo "===================================="
echo "📊 Test Results:"
echo "   ✅ Successful: $SUCCESS/${#MODELS[@]}"
echo "   ❌ Failed: $FAILED/${#MODELS[@]}"
echo ""

if [ $SUCCESS -eq ${#MODELS[@]} ]; then
  echo "🎉 All tests passed! Model switch retry logic works correctly."
  exit 0
else
  echo "⚠️  Some tests failed. Check logs for details."
  exit 1
fi
