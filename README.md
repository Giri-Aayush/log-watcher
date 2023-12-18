# Log Watcher (Similar to tail -f)

## Overview

This Log Watcher project implements a real-time log monitoring solution, similar to the UNIX `tail -f` command. It consists of a server-side program that monitors a log file on a remote machine and a web-based client that displays updates in real-time.

## Features

- **Real-time Monitoring:** Server-side program to stream updates from the log file.
- **Web-based Client:** A client interface that shows live updates without page refresh, displaying the last 10 lines of the log.
- **Performance Optimized:** Efficient handling of large log files.
- **Multi-client Support:** The server can handle multiple clients simultaneously.
- **No Page Reload:** The web page updates in real-time without reloading.

## Prerequisites

- Node.js environment.
- `protobuf-compiler` for protobuf support.

## Installation

1. **Install protobuf-compiler (Linux):**
    ```bash
    sudo apt install protobuf-compiler
    ```

2. **Clone the repository:**
    ```bash
    git clone https://github.com/Giri-Aayush/log-watcher
    ```

3. **Navigate to the project directory:**
    ```bash
    cd log-watcher
    ```

4. **Install dependencies:**
    ```bash
    npm install
    ```

## Running the Application

1. **Start the Server:**
    ```bash
    npm run start-server
    ```

2. **Access the Web Client:**
    Open `http://localhost:3000/log` in your web browser.

## Docker Deployment

1. **Build the Docker Image:**
    ```bash
    docker-compose build logwatcher
    ```

2. **Run the Docker Container:**
    ```bash
    docker-compose run --rm logwatcher
    ```

## Usage

- The server monitors the log file and updates the web client in real-time.
- Open multiple tabs to see multi-client support in action.
- Test by updating the monitored log file.

## License

This project is licensed under [MIT License](LICENSE).

## Contact

- [Aayush Giri on LinkedIn](https://www.linkedin.com/in/aayush-giri/)
- [Project Repository](https://github.com/Giri-Aayush/log-watcher)
