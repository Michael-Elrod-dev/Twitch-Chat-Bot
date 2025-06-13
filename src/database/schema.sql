CREATE TABLE tokens (
    id INT PRIMARY KEY AUTO_INCREMENT,
    token_key VARCHAR(50) UNIQUE NOT NULL,
    token_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE emotes (
    emote_id INT PRIMARY KEY AUTO_INCREMENT,
    trigger_text VARCHAR(50) UNIQUE NOT NULL,
    response_text VARCHAR(100) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE commands (
    command_id INT PRIMARY KEY AUTO_INCREMENT,
    command_name VARCHAR(50) UNIQUE NOT NULL,
    response_text TEXT NULL,
    handler_name VARCHAR(50) NULL,
    user_level ENUM('everyone', 'mod', 'broadcaster') NOT NULL DEFAULT 'everyone',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE viewers (
    user_id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(25) NOT NULL,
    is_moderator BOOLEAN DEFAULT FALSE,
    is_subscriber BOOLEAN DEFAULT FALSE,
    is_broadcaster BOOLEAN DEFAULT FALSE,
    last_seen DATETIME,
    UNIQUE KEY unique_username (username)
);

CREATE TABLE streams (
    stream_id VARCHAR(50) PRIMARY KEY,
    start_time DATETIME NOT NULL,
    end_time DATETIME,
    title VARCHAR(255),
    category VARCHAR(100),
    peak_viewers INT DEFAULT 0,
    total_messages INT DEFAULT 0,
    unique_chatters INT DEFAULT 0
);

CREATE TABLE viewing_sessions (
    session_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id VARCHAR(50) NOT NULL,
    stream_id VARCHAR(50) NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME,
    messages_sent INT DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES viewers(user_id),
    FOREIGN KEY (stream_id) REFERENCES streams(stream_id)
);

CREATE TABLE chat_messages (
    message_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id VARCHAR(50) NOT NULL,
    stream_id VARCHAR(50) NOT NULL,
    message_time DATETIME NOT NULL,
    message_content TEXT,
    message_type ENUM('message', 'command', 'redemption') NOT NULL DEFAULT 'message',
    FOREIGN KEY (user_id) REFERENCES viewers(user_id),
    FOREIGN KEY (stream_id) REFERENCES streams(stream_id)
);

CREATE TABLE chat_totals (
    user_id VARCHAR(50) PRIMARY KEY,
    message_count INT DEFAULT 0,
    command_count INT DEFAULT 0,
    redemption_count INT DEFAULT 0,
    total_count INT DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES viewers(user_id)
);

CREATE TABLE quotes (
    quote_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id VARCHAR(50) NOT NULL,
    message_content TEXT,
    FOREIGN KEY (user_id) REFERENCES viewers(user_id)
);

CREATE TABLE api_usage (
    user_id VARCHAR(50),
    api_type ENUM('claude', 'openai_image') NOT NULL,
    stream_id VARCHAR(50) NOT NULL,
    stream_count INT DEFAULT 0,
    PRIMARY KEY (user_id, api_type, stream_id),
    FOREIGN KEY (user_id) REFERENCES viewers(user_id),
    FOREIGN KEY (stream_id) REFERENCES streams(stream_id)
);