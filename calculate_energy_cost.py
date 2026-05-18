#!/usr/bin/env .venv/bin/python
"""Calculate cost per token for self-hosted model based on energy cost."""

def calculate_energy_cost_per_token(
    power_watts: float = 340,
    electricity_rate_per_kwh: float = 0.12,
    tokens_per_second: float = 150,
):
    """
    Calculate the cost per token based on energy consumption.

    Args:
        power_watts: GPU power consumption in watts (H100 ≈ 340W)
        electricity_rate_per_kwh: Cost per kWh (check your university rate)
        tokens_per_second: Model throughput (benchmark with your setup)

    Returns:
        Tuple of (input_cost_per_token, output_cost_per_token)
    """
    # Convert watts to kilowatts
    power_kw = power_watts / 1000

    # Cost per hour of running the GPU
    cost_per_hour = power_kw * electricity_rate_per_kwh

    # Tokens generated per hour
    tokens_per_hour = tokens_per_second * 3600

    # Cost per token
    cost_per_token = cost_per_hour / tokens_per_hour

    print("=" * 60)
    print("Energy Cost Calculation")
    print("=" * 60)
    print(f"GPU Power:            {power_watts}W")
    print(f"Electricity Rate:     ${electricity_rate_per_kwh}/kWh")
    print(f"Throughput:           {tokens_per_second} tokens/sec")
    print(f"\nCost per hour:        ${cost_per_hour:.4f}")
    print(f"Tokens per hour:      {tokens_per_hour:,}")
    print(f"\nCost per token:       ${cost_per_token:.10f}")
    print(f"Scientific notation:  {cost_per_token:.2e}")
    print("=" * 60)

    # For prompt vs completion, you could differentiate if input
    # processing is faster than generation
    print("\n💡 Recommendation:")
    if cost_per_token < 0.0000001:
        print(f"Cost is negligible (<$0.0001 per 1M tokens).")
        print("Suggest: Set to $0 in .env or use this for relative tracking:")
        print(f"\nLLM_INPUT_COST_PER_TOKEN={cost_per_token}")
        print(f"LLM_OUTPUT_COST_PER_TOKEN={cost_per_token}")
    else:
        print(f"Add to your .env:")
        print(f"\nLLM_INPUT_COST_PER_TOKEN={cost_per_token}")
        print(f"LLM_OUTPUT_COST_PER_TOKEN={cost_per_token}")

    return cost_per_token, cost_per_token


if __name__ == "__main__":
    import sys

    # Default values for LMU Munich setup
    power = 340  # H100 SXM5 TDP
    rate = 0.20  # USD/kWh - Munich industrial rate (~€0.18/kWh)
    throughput = 150  # tokens/sec (benchmark your actual model)

    # Common electricity rates (USD/kWh)
    RATES = {
        "munich": 0.20,      # Germany industrial (~€0.18/kWh)
        "us-avg": 0.12,      # US average
        "us-cheap": 0.08,    # US cheap states
        "eu-avg": 0.22,      # EU average industrial
    }

    # Allow command-line override
    if len(sys.argv) > 1:
        if sys.argv[1] in RATES:
            rate = RATES[sys.argv[1]]
            print(f"\nUsing preset rate: {sys.argv[1]} = ${rate}/kWh")
        else:
            power = float(sys.argv[1])
    if len(sys.argv) > 2:
        rate = float(sys.argv[2])
    if len(sys.argv) > 3:
        throughput = float(sys.argv[3])

    print("\nUsage: python calculate_energy_cost.py [watts|preset] [$/kWh] [tokens/sec]")
    print(f"Presets: {', '.join(RATES.keys())}")
    print(f"Using: {power}W, ${rate}/kWh, {throughput} tok/s\n")

    calculate_energy_cost_per_token(power, rate, throughput)

    print("\n📊 To benchmark your actual throughput:")
    print("  curl http://localhost:11434/api/generate -d '{")
    print('    "model": "your-model",')
    print('    "prompt": "Write a long story about...",')
    print('    "stream": true')
    print("  }' | jq -r '.eval_count, .eval_duration' | awk 'NR==1{tokens=$1} NR==2{print tokens/($1/1e9), \"tokens/sec\"}'")
