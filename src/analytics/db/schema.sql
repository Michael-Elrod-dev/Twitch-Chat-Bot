CREATE TABLE viewers (
    user_id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(25) NOT NULL,
    is_moderator BOOLEAN DEFAULT FALSE,
    is_subscriber BOOLEAN DEFAULT FALSE,
    subscriber_tier ENUM('none', 'tier1', 'tier2', 'tier3') DEFAULT 'none',
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

CREATE TABLE message_totals (
    user_id VARCHAR(50) NOT NULL,
    message_count INT DEFAULT 0,
    command_count INT DEFAULT 0,
    redemption_count INT DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES viewers(user_id)
);

CREATE TABLE quotes (
    quote_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id VARCHAR(50) NOT NULL,
    message_content TEXT,
    FOREIGN KEY (user_id) REFERENCES viewers(user_id)
);