from dotenv import load_dotenv

def main():
    if load_dotenv():
        
    else:
        raise Exception("Failed to load .env file")


if __name__ == "__main__":
    main()
