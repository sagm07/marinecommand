FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --home-dir /app app
COPY backend/requirements-lock.txt /app/requirements-lock.txt
RUN pip install --no-cache-dir -r /app/requirements-lock.txt
COPY backend /app/backend
USER app
EXPOSE 8000
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
