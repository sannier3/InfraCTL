# Appeler l'API depuis PHP

Le jeton reste dans l'environnement du processus PHP. Le navigateur envoie ses formulaires à PHP. PHP appelle Infra Manager.

PHP 8.1 ou plus récent, avec l'extension curl.

```bash
export INFRA_BASE_URL="http://127.0.0.1:8080"
export INFRA_TOKEN="dev-admin-token-change"
```

`INFRA_TOKEN` est `auth.apiToken` pour administrer, ou `auth.readToken` pour une page qui ne fait que lire et lancer `system.info` ou `apt.check`.

## Client

```php
<?php

declare(strict_types=1);

final class InfraClient
{
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $token,
    ) {
    }

    public static function fromEnv(): self
    {
        $baseUrl = getenv("INFRA_BASE_URL");
        $token = getenv("INFRA_TOKEN");
        if (!is_string($baseUrl) || $baseUrl === "" || !is_string($token) || $token === "") {
            throw new RuntimeException("INFRA_BASE_URL et INFRA_TOKEN sont requis");
        }
        return new self(rtrim($baseUrl, "/"), $token);
    }

    /** @return array<string, mixed> */
    public function get(string $path, array $query = []): array
    {
        return $this->request("GET", $path, $query, null);
    }

    /** @param array<string, mixed> $body */
    public function post(string $path, array $body): array
    {
        return $this->request("POST", $path, [], $body);
    }

    /** @param array<string, mixed> $body */
    public function patch(string $path, array $body): array
    {
        return $this->request("PATCH", $path, [], $body);
    }

    public function delete(string $path): array
    {
        return $this->request("DELETE", $path, [], null);
    }

    /**
     * @param array<string, scalar|null> $query
     * @param array<string, mixed>|null $body
     * @return array<string, mixed>
     */
    private function request(string $method, string $path, array $query, ?array $body): array
    {
        $url = $this->baseUrl . $path;
        if ($query !== []) {
            $url .= "?" . http_build_query($query);
        }

        $handle = curl_init($url);
        if ($handle === false) {
            throw new RuntimeException("curl_init a échoué");
        }

        $headers = ["Authorization: Bearer " . $this->token, "Accept: application/json"];
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => 20,
        ];
        if ($body !== null) {
            $headers[] = "Content-Type: application/json";
            $options[CURLOPT_HTTPHEADER] = $headers;
            $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
        }
        curl_setopt_array($handle, $options);

        $raw = curl_exec($handle);
        if ($raw === false) {
            $message = curl_error($handle);
            curl_close($handle);
            throw new RuntimeException($message);
        }
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        /** @var array<string, mixed> $decoded */
        $decoded = $raw === "" ? [] : json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        if ($status < 200 || $status >= 300) {
            $error = is_array($decoded["error"] ?? null) ? $decoded["error"] : [];
            $code = is_string($error["code"] ?? null) ? $error["code"] : "HTTP_" . $status;
            $message = is_string($error["message"] ?? null) ? $error["message"] : "appel refusé";
            throw new InfraApiException($status, $code, $message);
        }
        return $decoded;
    }
}

final class InfraApiException extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
    ) {
        parent::__construct($message, $status);
    }
}
```

`GET /api/v1/health` n'a pas besoin du jeton. Pour l'appeler sans en-tête, utiliser un `curl` séparé. Toutes les autres routes passent par ce client.

## Afficher le parc

```php
<?php

declare(strict_types=1);

require __DIR__ . "/InfraClient.php";

$client = InfraClient::fromEnv();
$page = max(1, (int) ($_GET["page"] ?? 1));
$machines = $client->get("/api/v1/machines", [
    "page" => $page,
    "limit" => 50,
    "includeHidden" => "false",
]);

header("Content-Type: text/html; charset=utf-8");
echo "<table><thead><tr><th>Nom</th><th>Type</th><th>État</th><th>Agent</th><th>Vu</th></tr></thead><tbody>";
foreach ($machines["data"] as $machine) {
    if (!is_array($machine)) {
        continue;
    }
    $id = (string) $machine["id"];
    echo "<tr>";
    echo "<td><a href=\"machine.php?id=" . rawurlencode($id) . "\">" . h((string) $machine["displayName"]) . "</a></td>";
    echo "<td>" . h((string) $machine["type"]) . "</td>";
    echo "<td>" . h((string) $machine["status"]) . "</td>";
    echo "<td>" . h((string) ($machine["agentId"] ?? "")) . "</td>";
    echo "<td>" . h((string) ($machine["lastSeenAt"] ?? "")) . "</td>";
    echo "</tr>";
}
echo "</tbody></table>";

$pagination = is_array($machines["pagination"] ?? null) ? $machines["pagination"] : [];
echo "<p>Page " . h((string) ($pagination["page"] ?? 1)) . " / " . h((string) ($pagination["pages"] ?? 1)) . "</p>";

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, "UTF-8");
}
```

La liste active omet les machines arrêtées depuis plus de cinq minutes. Passer `includeHidden=true` pour les revoir.

## Afficher une machine

Les extraits suivants continuent le script précédent : `$client` et `h()` existent déjà. Enchaîner trois lectures. Les ressources et les mises à jour peuvent être vides : ce n'est pas une erreur HTTP.

```php
$id = (string) ($_GET["id"] ?? "");
if (!preg_match('/^[0-9a-f-]{36}$/i', $id)) {
    http_response_code(400);
    exit("identifiant invalide");
}

$machine = $client->get("/api/v1/machines/" . rawurlencode($id));
$resources = $client->get("/api/v1/machines/" . rawurlencode($id) . "/resources", ["limit" => 20]);
$updates = $client->get("/api/v1/machines/" . rawurlencode($id) . "/updates", ["limit" => 1]);

$current = is_array($resources["current"] ?? null) ? $resources["current"] : null;
if ($current !== null) {
    $total = (int) $current["memoryTotal"];
    $used = (int) $current["memoryUsed"];
    $percent = $total > 0 ? (int) round($used * 100 / $total) : 0;
    echo "<p>CPU " . h((string) $current["cpuUsage"]) . " %</p>";
    echo "<p>Mémoire " . $percent . " %</p>";
}

$latest = is_array($updates["data"][0] ?? null) ? $updates["data"][0] : null;
if ($latest !== null) {
    echo "<p>Mises à jour disponibles : " . h((string) $latest["availableCount"]) . "</p>";
    foreach ($latest["packages"] as $package) {
        if (!is_array($package)) {
            continue;
        }
        echo "<li>" . h((string) $package["name"]) . " " . h((string) ($package["currentVersion"] ?? ""))
            . " → " . h((string) ($package["newVersion"] ?? "")) . "</li>";
    }
}
```

`cpuUsage` est déjà un pourcentage. La mémoire est en octets.

## Lancer une action

Le formulaire PHP poste le nom d'action et l'identifiant de machine. PHP construit le JSON. Il n'envoie jamais une commande shell.

```php
if (($_SERVER["REQUEST_METHOD"] ?? "") === "POST") {
    $action = (string) ($_POST["action"] ?? "");
    if (!in_array($action, ["system.info", "apt.check", "apt.upgrade"], true)) {
        http_response_code(400);
        exit("action non proposée");
    }
    try {
        $job = $client->post("/api/v1/actions", [
            "action" => $action,
            "requestedBy" => "page-php",
            "selector" => ["type" => "machine", "id" => $id],
        ]);
    } catch (InfraApiException $exception) {
        http_response_code($exception->status);
        exit(h($exception->errorCode . " : " . $exception->getMessage()));
    }
    header("Location: job.php?id=" . rawurlencode((string) $job["id"]));
    exit;
}
```

La réponse immédiate a `status` à `QUEUED` et `result` à `null`. Rediriger vers la page du job.

Pour tout le parc :

```php
$job = $client->post("/api/v1/actions", [
    "action" => "apt.check",
    "requestedBy" => "page-php",
    "selector" => ["type" => "fleet"],
]);
```

Ce job a `executionKind` égal à `PARENT`. Les machines se lisent ensuite avec :

```php
$children = $client->get("/api/v1/jobs", ["parentId" => (string) $job["id"], "limit" => 100]);
```

Une machine hors ligne devient un enfant `SKIPPED`. Le parent peut tout de même finir en `SUCCESS` si les autres enfants réussissent.

## Afficher le résultat et les journaux

```php
$jobId = (string) ($_GET["id"] ?? "");
$job = $client->get("/api/v1/jobs/" . rawurlencode($jobId));
$logs = $client->get("/api/v1/jobs/" . rawurlencode($jobId) . "/logs", ["limit" => 100]);

echo "<p>" . h((string) $job["action"]) . " — " . h((string) $job["status"]) . "</p>";

$terminal = ["SUCCESS", "FAILED", "SKIPPED", "INTERRUPTED", "UNKNOWN", "CANCELLED", "REQUIRES_CONFIRMATION"];
if (!in_array($job["status"], $terminal, true)) {
    echo '<meta http-equiv="refresh" content="2">';
}

if (is_array($job["result"] ?? null)) {
    echo "<pre>" . h((string) json_encode($job["result"], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)) . "</pre>";
}
if (is_string($job["errorMessage"] ?? null) && $job["errorMessage"] !== "") {
    echo "<p>" . h((string) $job["errorCode"]) . " — " . h((string) $job["errorMessage"]) . "</p>";
}

foreach ($logs["data"] as $line) {
    if (!is_array($line)) {
        continue;
    }
    echo "<pre>[" . h((string) $line["stream"]) . "] " . h((string) $line["data"]) . "</pre>";
}
```

La page se recharge tant que le job n'est pas terminé. `apt.check` peut durer plusieurs minutes. Un lot se suit sur le job parent : son `result.counts` résume les enfants.

Pour un script en ligne de commande, une boucle côté PHP convient mieux qu'un rafraîchissement HTML :

```php
$terminal = ["SUCCESS", "FAILED", "SKIPPED", "INTERRUPTED", "UNKNOWN", "CANCELLED", "REQUIRES_CONFIRMATION"];
do {
    sleep(2);
    $job = $client->get("/api/v1/jobs/" . rawurlencode($jobId));
} while (!in_array($job["status"], $terminal, true));
```

Ne pas boucler sans pause : le scheduler et l'agent avancent au rythme du heartbeat et du long polling, pas à celui des lectures.

## Annuler

```php
$client->post("/api/v1/jobs/" . rawurlencode($jobId) . "/cancel", []);
```

Le corps est un objet vide. Un job `RUNNING` répond `409` / `JOB_NOT_CANCELLABLE`. Cette route exige `apiToken`.

## Enregistrer un agent

`INFRA_TOKEN` doit être `apiToken`. Le secret est choisi ici, envoyé une fois, puis recopié dans le YAML de la machine. La réponse ne le contient pas.

```php
$secret = "un-secret-d-au-moins-16";
$agent = $client->post("/api/v1/agents", [
    "id" => "edge-01",
    "name" => "edge-01",
    "type" => "linux-node",
    "secret" => $secret,
]);
echo "<p>Agent " . h((string) $agent["id"]) . " enregistré</p>";

$client->patch("/api/v1/agents/edge-01", ["name" => "Bordure"]);
$client->post("/api/v1/agents/edge-01/secret", ["secret" => "un-autre-secret-16"]);
$client->delete("/api/v1/agents/edge-01");
```

`DELETE` répond `204` sans JSON. Le client ci-dessus traite un corps vide comme un tableau vide.

## Erreurs à traiter dans la page

| Code | Situation |
| --- | --- |
| `UNAUTHORIZED` | Jeton absent ou incorrect |
| `FORBIDDEN` | Jeton lecteur sur une route d'administrateur |
| `CONFLICT` | Identifiant d'agent déjà enregistré |
| `NOT_FOUND` | Machine, agent ou job inconnu |
| `ACTION_DISABLED` | Action du catalogue non activée, par exemple `apt.refresh` |
| `NO_TARGETS` | Sélecteur qui ne vise aucune machine compatible |
| `INCOMPATIBLE_TARGET` | Type de machine refusé pour cette action |
| `VALIDATION_ERROR` | JSON rejeté, souvent un champ en trop comme `command` |
