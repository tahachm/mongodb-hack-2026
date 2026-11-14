# One image, one process == one merchant (MERCHANT_ID/PORT select which at runtime).
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app
COPY gradlew ./
COPY gradle ./gradle
COPY build.gradle.kts settings.gradle.kts ./
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
COPY src ./src
RUN ./gradlew --no-daemon installDist

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/build/install/merchant ./
EXPOSE 8080
ENTRYPOINT ["./bin/merchant"]
