FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/tmp

# Node.js 22 (storage.js needs the built-in node:sqlite module, available from Node 22.5), LibreOffice (headless), Poppler, Ghostscript (compress/repair),
# qpdf (protect/unlock/repair) and fonts (Latin, Indic, Arabic, CJK) for translated PDFs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libreoffice-core \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    poppler-utils \
    ghostscript \
    qpdf \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-core \
    fonts-noto-cjk \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# PDF import filter used by "PDF to Word" (tries both packages, never fails the build)
RUN apt-get update \
    && (apt-get install -y --no-install-recommends libreoffice-draw libreoffice-pdfimport \
        || apt-get install -y --no-install-recommends libreoffice-draw \
        || true) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Python 3, pip, and document converter dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

# V8 heap limit well below the container's 512 MB so LibreOffice / Python children keep room (override with NODE_MAX_OLD_SPACE_MB)
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_MAX_OLD_SPACE_MB:-192} server.js"]
