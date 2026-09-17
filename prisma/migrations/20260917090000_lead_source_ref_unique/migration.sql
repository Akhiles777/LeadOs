-- CreateIndex
CREATE UNIQUE INDEX "Lead_source_sourceRef_key" ON "Lead"("source", "sourceRef");
