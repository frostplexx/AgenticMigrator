from dotenv import load_dotenv
from src.manager import MigrationManager

def main():
    if load_dotenv():
        _ = MigrationManager().migrate("") # Set up migration manager singleton
    else:
        raise Exception("Failed to load .env file")


if __name__ == "__main__":
    main()
