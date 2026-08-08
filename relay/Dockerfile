FROM python:3.12-slim

# System deps for cryptography (none currently needed for RSA + SHA256
# on Debian, but pip is).
WORKDIR /app

# Install Python deps. Using --no-cache-dir to keep the image small.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the relay.
COPY server.py ./

# Fly.io sets $PORT; default to 8080.
ENV PORT=8080
EXPOSE 8080

# Run as a non-root user for safety.
RUN useradd -m -u 1000 relay
USER relay

CMD ["python", "-u", "server.py"]
