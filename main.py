import argparse
from dotenv import load_dotenv
from src.manager import MigrationManager

def main():
    parser = argparse.ArgumentParser(description="Migrate a Chrome extension using an AI agent.")
    parser.add_argument("extension", help="Path to the unpacked Chrome extension directory")
    args = parser.parse_args()

    if load_dotenv():
        MigrationManager().migrate(args.extension)
    else:
        raise Exception("Failed to load .env file")


if __name__ == "__main__":
    main()
