package dec.aws

import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.test.context.bean.override.mockito.MockitoBean

@SpringBootTest
class AwsApplicationTests {

    @MockitoBean
    lateinit var jwtDecoder: JwtDecoder

    @Test
    fun contextLoads() {
    }
}